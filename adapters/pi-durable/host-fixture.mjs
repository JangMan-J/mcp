// Minimal MCP 2026-07-28 fixture for host.test.ts.
// `node host-fixture.mjs [logFile]` serves newline-delimited JSON-RPC on stdio;
// `startHttpFixture()` serves the same methods over Streamable HTTP on 127.0.0.1:0.
// Every tools/call is appended to `calls` (and to logFile in stdio mode) so tests
// can prove whether the host resent a request.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const PROTOCOL = '2026-07-28';
export const PNG = 'iVBORw0KGgo='; // tiny base64 payload, content is opaque to the host
const complete = fields => ({ resultType: 'complete', ...fields });
const capabilities = { tools: {}, prompts: {}, resources: {}, completions: {} };
const serverInfo = { name: 'host-fixture', version: '0' };
export const TOOLS = [
  { name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'image', description: 'return an image', inputSchema: { type: 'object', properties: {} } },
  { name: 'structured', description: 'structured result', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } },
  { name: 'write', description: 'side effect', inputSchema: { type: 'object', properties: { v: { type: 'string' } } } },
  { name: 'hang', description: 'never answers', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'tool error', inputSchema: { type: 'object', properties: {} } },
];

/** JSON-RPC handler shared by both transports; returns undefined for notifications / hang. */
export function createHandler(onCall = () => {}) {
  let writes = 0;
  const rpc = {
    initialize: () => ({ protocolVersion: PROTOCOL, serverInfo, capabilities }),
    'server/discover': () => complete({ supportedVersions: [PROTOCOL], serverInfo, capabilities }),
    'tools/list': () => complete({ tools: TOOLS }),
    'tools/call': p => {
      const a = p.arguments ?? {};
      switch (p.name) {
        case 'echo': return complete({ content: [{ type: 'text', text: String(a.text ?? '') }], _meta: { secret: 'strip-me' } });
        case 'image': return complete({ content: [{ type: 'text', text: 'pic' }, { type: 'image', data: PNG, mimeType: 'image/png' }] });
        case 'structured': return complete({ content: [{ type: 'text', text: 'ok' }], structuredContent: { doubled: Number(a.n) * 2 } });
        case 'write': return complete({ content: [{ type: 'text', text: `wrote ${a.v} #${++writes}` }] });
        case 'fail': return complete({ content: [{ type: 'text', text: 'boom' }], isError: true });
        case 'hang': return new Promise(() => {});
        default: throw Object.assign(new Error(`unknown tool ${p.name}`), { code: -32602 });
      }
    },
    'prompts/list': () => complete({ prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }] }),
    'prompts/get': p => complete({ messages: [{ role: 'user', content: { type: 'text', text: `hello ${p.arguments?.who}` } }] }),
    'completion/complete': p => complete({ completion: { values: ['world', 'wide'].filter(v => v.startsWith(p.argument?.value ?? '')) } }),
    'resources/list': () => complete({ resources: [{ uri: 'fixture://note', name: 'note', mimeType: 'text/plain' }] }),
    'resources/templates/list': () => complete({ resourceTemplates: [] }),
    'resources/read': p => complete({ contents: [{ uri: p.uri, mimeType: 'text/plain', text: `note ${p.uri}` }] }),
  };
  return async msg => {
    const { id, method, params = {} } = msg;
    if (method === 'tools/call') onCall({ name: params.name, arguments: params.arguments ?? {}, id });
    if (id === undefined) return undefined;
    const fn = Object.hasOwn(rpc, method) && rpc[method];
    if (!fn) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    try { return { jsonrpc: '2.0', id, result: await fn(params) }; }
    catch (e) { return { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: String(e.message) } }; }
  };
}

/** Streamable HTTP fixture; optional bearer token requirement. */
export async function startHttpFixture({ token } = {}) {
  const calls = [];
  const handle = createHandler(c => calls.push(c));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (new URL(req.url, 'http://x').pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const reply = await handle(JSON.parse(raw || '{}'));
    if (!reply) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, calls, close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections(); }) };
}

// stdio mode
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const log = process.argv[2];
  const handle = createHandler(c => { if (log) appendFileSync(log, `${JSON.stringify(c)}\n`); });
  createInterface({ input: process.stdin }).on('line', async line => {
    if (!line.trim()) return;
    const reply = await handle(JSON.parse(line));
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
