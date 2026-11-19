// Combined resource server and AS: the same bound resource URI must appear in
// discovery, authorization and token exchange. All grants and writes are local.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export async function startBindingPeer(scenario: string) {
  const posts: { id: unknown; method: unknown; target: string; authorization?: string; status: number }[] = [];
  const authorizeScopes: string[] = [];
  const paths: string[] = [];
  const codes = new Map<string, { challenge: string; scope: string }>();
  const grants = new Map<string, string>();
  let origin = '', writes = 0, error: unknown;
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    try {
      const url = new URL(req.url!, origin), p = url.searchParams;
      paths.push(url.pathname);
      const resource = `${origin}/mcp`, prm = `${origin}/.well-known/oauth-protected-resource/mcp`;
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8192) throw Error('oversize fixture request'); }
      if (url.href === prm) return json(200, { resource, authorization_servers: [origin] });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin,
        authorization_endpoint: origin.replace('http:', 'https:') + '/authorize', token_endpoint: origin + '/token', code_challenge_methods_supported: ['S256'] });
      if (url.pathname === '/authorize') {
        if (p.get('resource') !== resource || p.get('client_id') !== 'fixture-client' || p.get('code_challenge_method') !== 'S256') throw Error('bad authorization parameters');
        const scope = p.get('scope') ?? '';
        authorizeScopes.push(scope);
        const code = `fixture-code-${authorizeScopes.length}`;
        codes.set(code, { challenge: p.get('code_challenge')!, scope });
        const callback = new URL('/callback', origin);
        callback.searchParams.set('state', p.get('state')!); callback.searchParams.set('iss', origin); callback.searchParams.set('code', code);
        return res.writeHead(302, { location: callback.href }).end();
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body), code = form.get('code')!, entry = codes.get(code);
        codes.delete(code);
        if (!entry || form.get('resource') !== resource || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) throw Error('bad token exchange');
        const token = `fixture-token-${grants.size + 1}`;
        grants.set(`Bearer ${token}`, entry.scope);
        return json(200, { token_type: 'Bearer', access_token: token, expires_in: 300, scope: entry.scope });
      }
      if (url.pathname !== '/mcp' || req.method !== 'POST') throw Error('unexpected request');
      const { id, method } = JSON.parse(body);
      const authorization = req.headers.authorization, scope = grants.get(authorization ?? '');
      const status = scenario === 'plain-403' ? 403 : scenario === 'bearer' ? (authorization === 'Bearer fixture-configured' ? 200 : 401) :
        scope === undefined ? 401 : scenario === 'step-up' && writes > 0 && !scope.split(' ').includes('write') ? 403 : 200;
      posts.push({ id, method, target: req.url!, authorization, status });
      if (status === 200) return json(200, { jsonrpc: '2.0', id, result: { resultType: 'complete', write: ++writes } });
      if (scenario !== 'plain-403') res.setHeader('www-authenticate', `Bearer resource_metadata="${prm}", ` + (status === 401 ? 'scope="read"' : 'error="insufficient_scope", scope="write"'));
      return json(status, {});
    } catch (e) { error = e; return json(500, {}); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, posts, paths, authorizeScopes, check() { if (error) throw error; }, close: () => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  }) };
}
