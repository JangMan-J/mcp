// Synthetic OAuth server. Loopback only; never use with real credentials.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export async function startTestAuthorizationServer(redirectUri: string) {
  const codes = new Map<string, { challenge: string; expires: number }>();
  let issuer = '';
  const calls: { method: string; path: string }[] = [];
  const server = createServer(async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', issuer); }
    catch { return response.writeHead(400).end(); }
    calls.push({ method: request.method ?? '', path: url.pathname });
    const resource = `${issuer}/mcp`;
    const json = (status: number, value: unknown) => response.writeHead(status, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    }).end(JSON.stringify(value));
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(200, { resource, authorization_servers: [issuer], scopes_supported: ['read'] });
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer, authorization_endpoint: `${issuer.replace(/^http:/u, 'https:')}/authorize`, token_endpoint: `${issuer}/token`,
        code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      const challenge = p.get('code_challenge');
      if (!challenge || !/^[\w-]{43}$/u.test(challenge) || p.get('redirect_uri') !== redirectUri ||
        p.get('code_challenge_method') !== 'S256' || p.get('client_id') !== 'test-client' ||
        p.get('resource') !== resource || p.get('response_type') !== 'code' || !p.get('state')) return json(400, { error: 'invalid_request' });
      const callback = new URL(redirectUri);
      const code = randomBytes(24).toString('base64url');
      if (codes.size >= 100) codes.delete(codes.keys().next().value!);
      codes.set(code, { challenge, expires: Date.now() + 60_000 });
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', p.get('state')!);
      callback.searchParams.set('iss', issuer);
      return response.writeHead(302, { Location: callback.href, 'Cache-Control': 'no-store' }).end();
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      try {
        let text = '';
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 8192) return json(413, { error: 'invalid_request' });
        }
        const p = new URLSearchParams(text);
        const code = p.get('code') ?? '';
        const entry = codes.get(code);
        codes.delete(code);
        if (!entry || entry.expires <= Date.now() || p.get('grant_type') !== 'authorization_code' || p.get('client_id') !== 'test-client' ||
          p.get('resource') !== resource || p.get('redirect_uri') !== redirectUri ||
          createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { token_type: 'Bearer', access_token: 'test-access', expires_in: 300 });
      } catch { return json(400, { error: 'invalid_request' }); }
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization === 'Bearer test-access') return json(200, { ok: true });
      response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read"`);
      return json(401, {});
    }
    return json(404, {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test AS did not bind');
  issuer = `http://127.0.0.1:${address.port}`;
  return { issuer, resource: `${issuer}/mcp`, calls, close: () => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const redirect = process.argv[2];
  if (!redirect) throw new Error('usage: as-main.ts <registered-redirect-uri>');
  console.log((await startTestAuthorizationServer(new URL(redirect).href)).issuer);
}
