export const TASKS_ID = 'io.modelcontextprotocol/tasks';
export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
export interface TaskRecord {
  readonly serverKey: string; readonly taskId: string; readonly createdAt: number;
  readonly lastStatus: TaskStatus; readonly ttlMs?: number; readonly pollIntervalMs?: number;
}
export interface TaskStore {
  put(record: TaskRecord): void;
  get(serverKey: string, taskId: string): TaskRecord | undefined;
  list(serverKey: string): readonly TaskRecord[];
  delete(serverKey: string, taskId: string): void;
}
export class MemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>();
  put(r: TaskRecord) { this.records.set(JSON.stringify([r.serverKey, r.taskId]), { ...r }); }
  get(s: string, t: string) { return this.records.get(JSON.stringify([s,t])); }
  list(s: string) { return [...this.records.values()].filter(r => r.serverKey === s); }
  delete(s: string, t: string) { this.records.delete(JSON.stringify([s,t])); }
}
export type Obj = Record<string, unknown>;
export function object(x: unknown): x is Obj { return typeof x === 'object' && x !== null && !Array.isArray(x); }
export interface TaskState extends Obj {
  taskId: string; status: TaskStatus; ttl?: number | null; ttlMs?: number; pollIntervalMs?: number;
  inputRequests?: Record<string, {method: string; params: Obj}>;
}
const duration = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
export function valid(x: unknown): x is TaskState {
  return object(x) && typeof x.taskId === 'string' && x.taskId.trim().length > 0 &&
    ['working','input_required','completed','failed','cancelled'].includes(String(x.status)) &&
    (x.ttl === null || duration(x.ttl)) && duration(x.ttlMs) && duration(x.pollIntervalMs) &&
    (x.result === undefined || object(x.result)) && (x.error === undefined || object(x.error)) &&
    (x.inputRequests === undefined || (object(x.inputRequests) && Object.values(x.inputRequests).every(
      v => object(v) && typeof v.method === 'string' && object(v.params))));
}
