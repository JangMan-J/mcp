import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StdioTransport } from '@mcp/transport-stdio';
import { HttpTransport } from '@mcp/transport-http';
import { StatefulClient } from '@mcp/mrtr-cache';
import {
  McpClient, McpOutcomeError, META_CLIENT_CAPABILITIES, META_CLIENT_INFO,
  META_PROTOCOL_VERSION, NotificationQueue, unwrapOutcome,
  type Clock, type ExchangeEnd, type JsonRpcNotification, type JsonRpcRequest,
  type RequestId, type Transport, type TransportDiagnostic,
} from '../src/index.js';

const server = { key: 'test' };
const tick = () => new Promise<void>(r => setImmediate(r));

function makeInprocTransport() {
  const sent: { request: JsonRpcRequest; rawText: string }[] = [];
  const pending = new Map<string, { req: JsonRpcRequest; resolve: (end: ExchangeEnd) => void }>();
  const keyOf = (id: RequestId) => `${typeof id}:${String(id)}`;
  const transport: Transport = {
    binding: 'stdio',
    start(msg) {
      sent.push({ request: msg, rawText: JSON.stringify(msg) });
      const notifications: AsyncIterable<JsonRpcNotification> = { async *[Symbol.asyncIterator]() {} };
      const done = new Promise<ExchangeEnd>((resolve) => {
        pending.set(keyOf(msg.id), { req: msg, resolve });
      });
      return { notifications, done };
    },
    async notify() {},
    async close() {
      for (const [k, entry] of pending) {
        pending.delete(k);
        entry.resolve({ kind: 'failure', failure: { kind: 'closed', message: 'closed' }, delivery: 'maybe-delivered' });
      }
    },
    diagnostics: { async *[Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {} },
  };
  const deliverResult = (id: RequestId, result: Record<string, unknown>) => {
    const entry = pending.get(keyOf(id));
    if (!entry) return;
    pending.delete(keyOf(id));
    entry.resolve({ kind: 'response', message: { jsonrpc: '2.0', id, result } });
  };
  const deliverError = (id: RequestId, code: number, message: string, data?: unknown) => {
    const entry = pending.get(keyOf(id));
    if (!entry) return;
    pending.delete(keyOf(id));
    entry.resolve({ kind: 'response', message: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } } });
  };
  return Object.assign(transport, { sent, deliverResult, deliverError });
}

function makeFakeClock(): Clock & { advance(ms: number): void } {
  let nowMs = 0;
  let nextTimer = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { due: nowMs + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, t] of [...timers]) {
        if (t.due <= nowMs) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

it('[WIRE-DIR-1] the stdio send seam rejects both kinds of response envelope', async () => {
  const transport = new StdioTransport({ command: process.execPath });
  const ctx = { signal: new AbortController().signal, timeoutMs: 1000, idempotent: true };
  try {
    for (const body of [{ result: {} }, { error: { code: -32603, message: 'internal' } }]) {
      const envelope = { jsonrpc: '2.0', id: 42, ...body } as unknown as JsonRpcRequest;
      expect(() => transport.start(envelope, ctx)).toThrow(/response envelope/i);
    }
  } finally { await transport.close(); }
});

it('[WIRE-META-4] caller cannot override version or capabilities before send; clientInfo is optional', async () => {
  const transport = makeInprocTransport();
  const client = new McpClient({ server, transport, clientInfo: false });
  for (const key of [META_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES]) {
    expect(() => client.request('tools/list', {}, { meta: { [key]: {} } })).toThrow(/reserved/i);
  }
  expect(transport.sent).toHaveLength(0);
  const call = client.request('tools/list');
  expect(Object.keys(transport.sent[0]!.request.params!._meta as object)).not.toContain(META_CLIENT_INFO);
  transport.deliverResult(call.id, { tools: [] });
  expect((await call).kind).toBe('ok');
});

it('[WIRE-META-5] invalid prefix/name is rejected; valid plain and namespaced keys reach the wire', async () => {
  const transport = makeInprocTransport();
  const client = new McpClient({ server, transport });
  for (const key of ['bad prefix/name', 'example.org/', '/name', 'example.org/a/b', 'bad key']) {
    expect(() => client.request('tools/list', {}, { meta: { [key]: 1 } })).toThrow(/syntax/);
  }
  expect(transport.sent).toHaveLength(0);
  const meta = { trace: 't', 'example.org/job-id': 9 };
  const call = client.request('tools/list', {}, { meta });
  expect(transport.sent[0]!.request.params?._meta).toMatchObject(meta);
  transport.deliverResult(call.id, { tools: [] });
  expect((await call).kind).toBe('ok');
});

it('[API-OUT-1] request resolves to a discriminated outcome; unwrap returns the value or throws McpOutcomeError', async () => {
  const transport = makeInprocTransport();
  const client = new McpClient({ server, transport });
  const ok = client.request('tools/list');
  transport.deliverResult(ok.id, { tools: [] });
  expect(unwrapOutcome(await ok)).toEqual({ tools: [] });
  const bad = client.request('tools/list');
  transport.deliverError(bad.id, -32603, 'internal');
  const out = await bad;
  expect(out).toMatchObject({ kind: 'jsonrpc-error', code: -32603 });
  expect(() => unwrapOutcome(out)).toThrow(McpOutcomeError);
});

// This peer logs every stdin frame, including any attempted response to its own ping.
function peer(dir: string, body: string) {
  const program = `const fs = require('node:fs');
    const send = m => console.log(JSON.stringify({jsonrpc:'2.0', ...m}));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      fs.appendFileSync('wire', line+'\\n'); const req = JSON.parse(line);
      if (!req.method || req.id == null) return;
      ${body}
    });`;
  const transport = new StdioTransport({ command: process.execPath, cwd: dir, args: ['-e', program] });
  const client = new McpClient({ server, transport, defaults: { timeoutMs: 3000 } });
  return { client, transport };
}
const stdin = (dir: string): JsonRpcRequest[] => readFileSync(join(dir, 'wire'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));

it('[WIRE-DIR-2] [LIFE-2] [WIRE-ERR-2] unsolicited ping and id-less error are diagnostic only; neither elicits a reply nor fails the pending call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-'));
  const { client, transport } = peer(dir, `send({id:'server-ping', method:'ping'});
    send({error:{code:-32700, message:'unreadable id'}});
    send({id:req.id, result:{tools:[]}});`);
  try {
    expect(unwrapOutcome(await client.request('tools/list'))).toEqual({ tools: [] });
    await client.close();
    expect(stdin(dir).map(r => r.method)).toEqual(['tools/list']);
    const messages = transport.diagnosticsSnapshot().map(d => d.message);
    expect(messages.filter(m => m.includes('server-initiated request ignored') && m.includes('ping'))).toHaveLength(1);
    expect(messages.some(m => /unreadable id|uncorrelated error|missing id/i.test(m))).toBe(true);
  } finally { await transport.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('[WIRE-STATE-1] [WIRE-STATE-2] [LIFE-3] an explicit resource URI works unchanged on the same peer or a fresh stdio process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-state-'));
  const body = `if (req.method === 'resources/list') send({id:req.id,result:{resources:[{uri:'test://opaque/7',name:'seven'}]}});
    else if (req.method === 'resources/read' && req.params.uri === 'test://opaque/7') send({id:req.id,result:{contents:[{uri:req.params.uri,text:'seven'}]}});
    else send({id:req.id,error:{code:-32602,message:'missing handle'}});`;
  const first = peer(dir, body).client;
  const next = peer(dir, body).client;
  try {
    const { resources } = unwrapOutcome(await first.request<{ resources: { uri: string }[] }>('resources/list'));
    const params = { uri: resources[0]!.uri };
    const read = async (c: McpClient) => unwrapOutcome(await c.request('resources/read', params));
    const original = await read(first);
    await first.close();
    expect(await read(next)).toEqual(original);
    expect(original).toEqual({ contents: [{ uri: 'test://opaque/7', text: 'seven' }] });
    await next.close();
    const requests = stdin(dir);
    expect(requests.map(r => r.method)).toEqual(['resources/list', 'resources/read', 'resources/read']);
    for (const r of requests.slice(1)) expect(r.params).toEqual({ uri: params.uri, _meta: requests[0]!.params!._meta });
  } finally { await first.close(); await next.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('[WIRE-CANCEL-1] cancelling a settled stdio call writes no cancellation frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-cancel-'));
  const { client } = peer(dir, 'send({id:req.id,result:{tools:[]}});');
  try {
    const call = client.request('tools/list');
    expect((await call).kind).toBe('ok');
    call.cancel('late');
    await client.request('tools/list'); // flush queued writes before closing stdin
    await client.close();
    expect(stdin(dir).map(r => r.method)).toEqual(['tools/list', 'tools/list']);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('[WIRE-TO-2] progress just before the hard deadline cannot extend a longer requested timeout', async () => {
  const clock = makeFakeClock();
  const queues = new Map<RequestId, NotificationQueue<JsonRpcNotification>>();
  const transport: Transport = {
    binding: 'stdio',
    start(req) {
      const q = new NotificationQueue<JsonRpcNotification>();
      queues.set(req.id, q);
      return { notifications: q, done: new Promise<ExchangeEnd>(() => {}) };
    },
    async notify() {},
    async close() {},
    diagnostics: { async *[Symbol.asyncIterator]() {} },
  };
  const client = new McpClient({ transport, server, ports: { clock } });
  const seen: number[] = [];
  const call = client.request('tools/list', {}, { timeoutMs: 900_000, onProgress: p => seen.push(p.progress) });
  clock.advance(599_999);
  queues.get(call.id)!.push({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: call.id, progress: 9 } });
  await tick();
  expect(seen).toEqual([9]);
  clock.advance(1);
  expect(await call).toMatchObject({ kind: 'transport-failure', failure: { kind: 'timeout' } });
});

it('[DEP-INCLUDECTX-1] sampling input requesting allServers fails closed without a context-bearing retry', async () => {
  const transport = makeInprocTransport();
  const core = new McpClient({ server, transport });
  const client = new StatefulClient({ serverRef: server.key, serverLabel: server.key, request: core.request.bind(core) });
  const pending = client.request('prompts/get', { name: 'p' });
  await tick();
  transport.deliverResult(transport.sent[0]!.request.id, { resultType: 'input_required', inputRequests: {
    sample: { method: 'sampling/createMessage', params: { includeContext: 'allServers' } },
  } });
  expect(await pending).toMatchObject({ kind: 'protocol-violation', detail: { reason: 'unsupported-input-request' } });
  expect(transport.sent).toHaveLength(1);
  expect(transport.sent[0]!.rawText).not.toContain('includeContext');
});

it('[DEP-HTTPSSE-1] a legacy SSE endpoint announcement is never followed', async () => {
  const url = 'https://example.test/mcp';
  const requests: string[] = [];
  const transport = new HttpTransport({ url, fetchPort: { async fetch(input, init) {
    requests.push(`${init.method} ${input}`);
    return new Response('event: endpoint\ndata: https://example.test/messages?sessionId=old\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } } });
  const client = new McpClient({ transport, server });
  try {
    expect(await client.request('tools/list', {}, { idempotent: true })).toMatchObject({ kind: 'transport-failure' });
    expect(requests).toEqual([`POST ${url}`]);
  } finally { await client.close(); }
});
