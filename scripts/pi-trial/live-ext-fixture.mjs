// Synthetic loopback MCP server (protocol 2026-07-28) + OAuth authorization server.
// Model-free, scratch-only: binds 127.0.0.1 on an ephemeral port, holds no files.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomBytes} from 'node:crypto';

export const PROTOCOL = '2026-07-28';
export const RESOURCE = 'fixture://clock', EVENT = 'clock.changed', TASK = 'fixture-task', SKILL = 'skill://fixture/live-check';
export const SKILL_FILE = `${SKILL}/SKILL.md`, SKILL_BODY = '---\nname: live-check\ndescription: Live fixture skill\n---\nFixture skill instructions.\n';
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';
const complete = fields => ({resultType:'complete', ...fields});
const text = value => ({content:[{type:'text', text:value}]});
const digest = value => createHash('sha256').update(value);
const state = (status, fields) => ({resultType:'task', taskId:TASK, status, pollIntervalMs:20, ...fields});
const input = state('input_required', {inputRequests:{answer:{method:'elicitation/create', params:{mode:'form', message:'Enter fixture answer',
  requestedSchema:{type:'object', properties:{value:{type:'string'}}, required:['value']}}}}});

export async function startFixture({browserShim = false} = {}) {
  const tokens = new Set(), codes = new Map(), listeners = new Set(), streams = new Set(), events = [], calls = [];
  let base, tick = 0, task;
  let oauthExchanges = 0;
  const tool = {name:'echo', description:'echo text', inputSchema:{type:'object', properties:{text:{type:'string'}}}};
  const taskTool = {name:'ask', description:'start a task that asks for input', inputSchema:{type:'object', properties:{}}};
  const prompt = {name:'greet', arguments:[{name:'who', required:true}]};
  const resource = {uri:RESOURCE, name:'clock', mimeType:'text/plain'};
  const skill = {uri:SKILL, name:'live-check', description:'Live fixture skill', resources:'static',
    files:[{uri:SKILL_FILE, size:Buffer.byteLength(SKILL_BODY), sha256:digest(SKILL_BODY).digest('hex')}]};
  const capabilities = {tools:{}, prompts:{}, resources:{}, completions:{},
    extensions:Object.fromEntries(['events', 'tasks', 'skills'].map(name => [`io.modelcontextprotocol/${name}`, {}]))};
  const serverInfo = {name:'live-ext-fixture', version:'0'};
  const rpc = {
    initialize: () => ({protocolVersion:PROTOCOL, serverInfo, capabilities}),
    'server/discover': () => complete({supportedVersions:[PROTOCOL], serverInfo, capabilities}),
    'tools/list': () => complete({tools:[tool, taskTool]}),
    'tools/search': p => complete({tools:[tool, taskTool].filter(t => t.name.includes(p?.query ?? ''))}),
    'tools/call': p => p.name === taskTool.name ? (task = state('working')) : complete(text(String(p.arguments?.text ?? ''))),
    'prompts/list': () => complete({prompts:[prompt]}),
    'prompts/get': p => complete({messages:[{role:'user', content:{type:'text', text:`hello ${p.arguments?.who}`}}]}),
    'completion/complete': p => complete({completion:{values:['world', 'wide'].filter(v => v.startsWith(p.argument?.value ?? ''))}}),
    'resources/list': () => complete({resources:[resource]}),
    'resources/read': p => complete({contents:[{uri:p.uri, mimeType:'text/plain', text:p.uri === SKILL_FILE ? SKILL_BODY : `fixture tick ${tick}`}]}),
    'events/list': () => complete({events:[{name:EVENT, description:'clock change', inputSchema:{type:'object'}, outputSchema:{type:'object'}}]}),
    'events/poll': p => complete({events:events.slice(Number(p.cursor ?? 0)), cursor:String(events.length), truncated:false}),
    'tasks/get': () => task = task?.status === 'working' ? input : task,
    'tasks/update': p => {
      assert.equal(p.taskId, TASK);
      assert.equal(task?.status, 'input_required');
      assert.deepEqual(p.inputResponses?.answer, {action:'accept', content:{value:'fixture reply'}});
      return task = state('completed', {result:complete(text('task received fixture reply'))});
    },
    'skills/list': () => complete({skills:[skill]}),
    'skills/get': p => { assert.equal(p.uri, SKILL); return complete({skill}); },
  };
  const notify = (res, id, method, params) => res.write(`data: ${JSON.stringify({jsonrpc:'2.0', method,
    params:{...params, _meta:{[SUB_ID]:id}}})}\n\n`);
  function openStream(set, res, id, details) {
    res.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-cache'});
    const stream = {res, id, ...details};
    set.add(stream);
    res.on('close', () => set.delete(stream));
    return stream;
  }
  function bump(kind) {
    if (kind !== 'event') {
      tick++;
      for (const {res, id, notifications} of listeners) if (notifications.resourceSubscriptions?.includes(RESOURCE))
        notify(res, id, 'notifications/resources/updated', {uri:RESOURCE});
    }
    if (kind !== 'resource') {
      const cursor = String(events.length + 1);
      const event = {eventId:`fixture-event-${cursor}`, name:EVENT, timestamp:new Date().toISOString(), data:{marker:`event ${cursor}`}, cursor};
      events.push(event);
      for (const {res, id} of streams) notify(res, id, 'notifications/events/event', event);
    }
    return {tick, cursor:String(events.length)};
  }
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, {'content-type':'application/json', ...headers}); res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) send(res, 400, {error:String(error.message)});
      else res.destroy();
    });
  });
  async function handle(req, res) {
    const url = new URL(req.url, base);
    let raw = ''; for await (const c of req) raw += c;
    if (url.pathname === '/inspect') return send(res, 200, {calls, oauthExchanges, resources:[...listeners].flatMap(s => s.notifications.resourceSubscriptions ?? []), streams:streams.size});
    if (url.pathname === '/bump' && req.method === 'POST') return send(res, 200, bump(url.searchParams.get('kind')));
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource')
      return send(res, 200, {resource:`${base}/mcp`, authorization_servers:[base]});
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return send(res, 200, {issuer:base, authorization_endpoint:`${browserShim ? base.replace(/^http:/, 'https:') : base}/authorize`, token_endpoint:`${base}/token`, registration_endpoint:`${base}/register`,
        token_endpoint_auth_methods_supported:['none'], response_types_supported:['code'], code_challenge_methods_supported:['S256'], grant_types_supported:['authorization_code']});
    if (url.pathname === '/register') {
      const registration = JSON.parse(raw);
      return send(res, 201, {...registration, client_id:'fixture-client', token_endpoint_auth_method:'none'});
    }
    if (url.pathname === '/authorize') { // browser shim target: auto-approves, redirects with code
      const code = randomBytes(8).toString('hex');
      const to = new URL(url.searchParams.get('redirect_uri'));
      assert.equal(to.protocol, 'http:');
      assert(['127.0.0.1', 'localhost', '[::1]'].includes(to.hostname), 'callback must be loopback');
      codes.set(code, url.searchParams.get('code_challenge'));
      to.searchParams.set('code', code); to.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, {location:to.href}); return res.end();
    }
    if (url.pathname === '/token') {
      const p = new URLSearchParams(raw), challenge = codes.get(p.get('code'));
      const ok = challenge && createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge;
      if (!ok) return send(res, 400, {error:'invalid_grant'});
      codes.delete(p.get('code'));
      const t = randomBytes(8).toString('hex'); tokens.add(t); oauthExchanges++;
      return send(res, 200, {access_token:t, token_type:'Bearer', expires_in:3600});
    }
    if (url.pathname !== '/mcp') return send(res, 404, {});
    if (!tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, '')))
      return send(res, 401, {}, {'www-authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
    const msg = JSON.parse(raw || '{}');
    const {id, method, params = {}} = msg;
    calls.push({method, params});
    if (id === undefined) { res.writeHead(202); return res.end(); }
    if (method === 'subscriptions/listen') {
      const notifications = params.notifications ?? {};
      openStream(listeners, res, id, {notifications});
      notify(res, id, 'notifications/subscriptions/acknowledged', {notifications});
      return;
    }
    if (method === 'events/stream') {
      assert.equal(params.name, EVENT);
      openStream(streams, res, id, {});
      notify(res, id, 'notifications/events/active', {cursor:String(events.length), truncated:false, heartbeatMs:1000});
      for (const event of events.slice(Number(params.cursor ?? events.length))) notify(res, id, 'notifications/events/event', event);
      const heartbeat = setInterval(() => notify(res, id, 'notifications/events/heartbeat', {}), 500);
      res.on('close', () => clearInterval(heartbeat));
      return;
    }
    const fn = Object.hasOwn(rpc, method) && rpc[method];
    send(res, 200, fn ? {jsonrpc:'2.0', id, result:fn(params)} : {jsonrpc:'2.0', id, error:{code:-32601, message:'method not found'}});
  }
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {base, mcpUrl:`${base}/mcp`, bump, close: () => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })};
}

// Health: full OAuth (PKCE) + MCP round trip with plain fetch, no SDK.
export async function fixtureHealth(fx) {
  const unauth = await fetch(fx.mcpUrl, {method:'POST', body:'{}'});
  if (unauth.status !== 401 || !unauth.headers.get('www-authenticate')) throw new Error('fixture: expected 401 challenge');
  const as = await (await fetch(`${fx.base}/.well-known/oauth-authorization-server`)).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = new URL(as.authorization_endpoint);
  Object.entries({response_type:'code', redirect_uri:'http://127.0.0.1:1/cb', code_challenge:challenge, code_challenge_method:'S256', state:'s'})
    .forEach(([k, v]) => auth.searchParams.set(k, v));
  const loc = new URL((await fetch(auth, {redirect:'manual'})).headers.get('location'));
  const tok = await (await fetch(as.token_endpoint, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code', code:loc.searchParams.get('code'), code_verifier:verifier})})).json();
  if (!tok.access_token) throw new Error('fixture: token exchange failed');
  const request = (method, params) => fetch(fx.mcpUrl, {method:'POST', signal:AbortSignal.timeout(3000),
    headers:{authorization:`Bearer ${tok.access_token}`, 'content-type':'application/json', accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0', id:1, method, params})});
  const call = async (method, params) => {
    const res = await request(method, params);
    assert(res.ok, `${method}: ${res.status}`);
    const json = await res.json();
    assert(!json.error, `${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  };
  async function* stream(method, params) {
    const res = await request(method, params);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    let buffer = '';
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        yield JSON.parse(frame.slice('data: '.length));
      }
    }
  }
  assert.deepEqual((await call('server/discover')).supportedVersions, [PROTOCOL]);
  assert.equal((await call('tools/call', {name:'echo', arguments:{text:'ok'}})).content[0].text, 'ok');
  const sub = stream('subscriptions/listen', {notifications:{resourceSubscriptions:[RESOURCE]}});
  const push = stream('events/stream', {name:EVENT});
  const next = async s => (await s.next()).value;
  try {
    const ack = await next(sub);
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
    assert.deepEqual(ack.params, {notifications:{resourceSubscriptions:[RESOURCE]}, _meta:{[SUB_ID]:1}});
    assert.equal((await next(push)).method, 'notifications/events/active');
    fx.bump();
    assert.equal((await next(sub)).params.uri, RESOURCE);
    const event = await next(push);
    assert.equal(event.method, 'notifications/events/event');
    assert.equal(event.params.cursor, '1');
    assert.equal((await call('events/poll', {cursor:'0'})).events[0].eventId, event.params.eventId);
    assert.deepEqual((await call('events/poll', {cursor:'1'})).events, []);
  } finally {
    await Promise.all([sub.return(), push.return()]);
  }
  assert.equal((await call('tools/call', {name:'ask'})).status, 'working');
  assert.equal((await call('tasks/get', {taskId:TASK})).status, 'input_required');
  assert.equal((await call('tasks/update', {taskId:TASK, inputResponses:{answer:{action:'accept', content:{value:'fixture reply'}}}})).status, 'completed');
  const {skill} = await call('skills/get', {uri:SKILL});
  const file = (await call('resources/read', {uri:SKILL_FILE})).contents[0].text;
  assert.equal(skill.files[0].sha256, digest(file).digest('hex'));
  return {oauth:'pass', mcp:'pass', subscriptions:'pass', events:'pass', tasks:'pass', skills:'pass'};
}
