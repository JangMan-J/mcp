import type { Clock, Outcome, RequestOptions, StreamHandle } from '@mcp-client/core';
import { elicit, type ElicitationOptions } from '@mcp-client/mrtr-cache';
import { MemoryTaskStore, TASKS_ID, object, valid, type Obj, type TaskState, type TaskStore } from './model.js';

export interface TasksOptions {
  serverKey?: string; store?: TaskStore; clock?: Clock; healthy?: boolean; force?: boolean;
  peerCapabilities?: Obj | (() => Obj); elicitation?: ElicitationOptions;
  request?: (method: string, params: Obj, options: RequestOptions) => PromiseLike<Outcome<unknown>>;
}
const meta = (method: string) => ({ requestId: 0, method, binding: 'extension', attempts: 0 });
const violation = (method: string, detail: string): Outcome<unknown> => ({kind:'protocol-violation', detail, meta:meta(method)});
export class TasksRuntime {
  readonly store: TaskStore; readonly serverKey: string; readonly clock: Clock;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(readonly opts: TasksOptions = {}) {
    this.store = opts.store ?? new MemoryTaskStore(); this.serverKey = opts.serverKey ?? 'default';
    this.clock = opts.clock ?? {now: Date.now, setTimeout(fn, ms) { const t = setTimeout(fn,ms); return () => clearTimeout(t); }};
  }
  refusal(method: string): Outcome<unknown> | undefined {
    const absent = (): Outcome<unknown> => ({kind:'capability-absent', detail:TASKS_ID, meta:meta(method)});
    if (this.opts.healthy === false) return absent();
    const caps = typeof this.opts.peerCapabilities === 'function' ? this.opts.peerCapabilities() : this.opts.peerCapabilities;
    const exts = caps?.extensions;
    if (exts !== undefined && !object(exts)) return violation(method,'invalid extensions');
    if (!exts || !Object.hasOwn(exts,TASKS_ID)) return this.opts.force ? undefined : absent();
    const s = exts[TASKS_ID];
    if (!object(s) || Object.keys(s).some(k => k !== 'revision') || ('revision' in s && typeof s.revision !== 'string'))
      return violation(method,'invalid task settings');
    if (s.revision !== undefined && s.revision !== '2026-07-28') return absent();
  }
  remember(s: TaskState) {
    const old = this.store.get(this.serverKey,s.taskId);
    const ttl = s.ttl === null ? undefined : s.ttlMs ?? s.ttl ?? old?.ttlMs;
    const interval = s.pollIntervalMs ?? old?.pollIntervalMs;
    this.store.put({serverKey:this.serverKey, taskId:s.taskId, createdAt:old?.createdAt ?? this.clock.now(), lastStatus:s.status,
      ...(ttl !== undefined && {ttlMs:ttl}), ...(interval !== undefined && {pollIntervalMs:interval})});
  }
  accept(s: Obj): Outcome<unknown> {
    const refused = this.refusal('task'); if (refused) return refused;
    if (!valid(s)) return violation('task','invalid CreateTaskResult');
    this.remember(s); return {kind:'task-handle', handle:new TaskHandle(this,s.taskId,s), meta:meta('task')};
  }
  resume(id: string) { return new TaskHandle(this,id); }
  resumeAll() { return this.store.list(this.serverKey).map(r => this.resume(r.taskId)); }
  wait(id: string): Promise<void> {
    const interval = this.store.get(this.serverKey,id)?.pollIntervalMs;
    return new Promise(resolve => {
      const group = this.listeners.get(id) ?? new Set(); this.listeners.set(id,group);
      let clear = () => {};
      const finish = () => { clear(); group.delete(finish); if (!group.size) this.listeners.delete(id); resolve(); };
      if (!interval) group.add(finish); // Notifications can shorten the fallback delay, never the server minimum.
      clear = this.clock.setTimeout(finish,interval ?? 1000);
    });
  }
  async listen(stream: StreamHandle) {
    for await (const n of stream) if (n.method === 'notifications/tasks' && object(n.params) && typeof n.params.taskId === 'string')
      this.listeners.get(n.params.taskId)?.forEach(fn => fn());
  }
}
export class TaskHandle {
  constructor(readonly runtime: TasksRuntime, readonly id: string, private state?: TaskState) {}
  status() { return this.state?.status ?? this.runtime.store.get(this.runtime.serverKey,this.id)?.lastStatus; }
  private async send(method: string, extra: Obj = {}): Promise<Outcome<unknown>> {
    const rt = this.runtime, denied = rt.refusal(method); if (denied) return denied;
    if (!rt.opts.request) return violation(method,'task request port missing');
    const out = await rt.opts.request(method,{taskId:this.id,...extra},{headersHint:{name:this.id}, idempotent:method === 'tasks/get'});
    const s = out.kind === 'task-handle' && out.handle instanceof TaskHandle ? out.handle.state : out.kind === 'ok' ? out.value : undefined;
    if (out.kind !== 'ok' && out.kind !== 'task-handle') return out;
    if (!valid(s) || s.taskId !== this.id) return violation(method,'invalid task response');
    this.state = s; rt.remember(s); return {kind:'ok',value:s,meta:out.meta};
  }
  async get() { const denied = this.runtime.refusal('tasks/get'); if (denied) return denied;
    await this.runtime.wait(this.id); return this.send('tasks/get'); }
  cancel() { return this.send('tasks/cancel'); }
  async update(inputResponses?: Obj): Promise<Outcome<unknown>> {
    const denied = this.runtime.refusal('tasks/update'); if (denied) return denied;
    const requests = this.state?.inputRequests;
    if (!inputResponses) {
      const opts = this.runtime.opts.elicitation;
      if (!requests || !opts) return violation('tasks/update','missing task input');
      const responses: Obj = Object.create(null);
      for (const [key,req] of Object.entries(requests)) {
        if (req.method !== 'elicitation/create') return violation('tasks/update','unsupported task input');
        try { responses[key] = await elicit(req.params,opts,new AbortController().signal); }
        catch { return violation('tasks/update','elicitation failed'); }
      }
      inputResponses = responses;
    }
    if (requests && (Object.keys(requests).length !== Object.keys(inputResponses).length ||
      Object.keys(requests).some(k => !Object.hasOwn(inputResponses!,k)))) return violation('tasks/update','input keys differ');
    return this.send('tasks/update',{inputResponses});
  }
  async poll(inputResponses?: Obj): Promise<Outcome<unknown>> {
    for (;;) {
      const s = this.state;
      if (s && s.status !== 'working' && s.status !== 'input_required')
        return {kind:'ok',value:s.status === 'completed' ? s.result : s.status === 'failed' ? s.error : s,meta:meta('tasks/get')};
      const out = s?.status === 'input_required' ? await this.update(inputResponses) : await this.get();
      if (s?.status === 'input_required') inputResponses = undefined;
      if (out.kind !== 'ok') return out;
    }
  }
}
