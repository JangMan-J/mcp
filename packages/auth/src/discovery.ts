import type { FetchPort } from '@mcp-client/core';
import { AuthError, fail, secureUrl } from './protocol.js';

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-document');
  return value as JsonObject;
};
export const strings = (value: unknown): string[] => Array.isArray(value) && value.every((x) => typeof x === 'string') ? value : [];
export interface Metadata {
  readonly issuer: string;
  readonly authorizationEndpoint: URL;
  readonly tokenEndpoint: URL;
  readonly cimd: boolean;
  readonly responseIssuer: boolean;
  readonly scopes: readonly string[];
  readonly clientAuthMethods: readonly string[];
  readonly registrationEndpoint?: URL;
}

export interface DiscoveryOptions {
  readonly allowInsecureDev?: boolean;
  readonly onDiagnostic?: (message: string) => void;
  readonly chooseAuthorizationServer?: (candidates: readonly string[]) => string | Promise<string>;
}

export async function getDocument(fetcher: FetchPort, url: string, signal: AbortSignal): Promise<JsonObject | undefined> {
  let response: Response;
  try { response = await fetcher.fetch(url, { method: 'GET', credentials: 'omit', redirect: 'manual', signal }); }
  catch (error) { if (error instanceof AuthError) throw error; return fail('discovery-fetch'); }
  if (response.status === 404 || response.status === 410) { await response.body?.cancel(); return undefined; }
  if (!response.ok) { await response.body?.cancel(); fail('discovery-fetch'); }
  try { return object(await response.json()); } catch { return fail('invalid-document'); }
}

export async function discover(fetcher: FetchPort, resource: string, requestUrl: string, location: string | undefined,
  options: DiscoveryOptions, signal: AbortSignal): Promise<{ metadata: Metadata; scopes: string[]; resource: string }> {
  const url = secureUrl(resource, options.allowInsecureDev);
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  const locations = location !== undefined ? [secureUrl(location, options.allowInsecureDev).href] :
    [...new Set([`${root}${url.pathname === '/' ? '' : url.pathname}${url.search}`, root])];
  let prm: (JsonObject & { resource: string }) | undefined;
  for (const candidate of locations) {
    const doc = await getDocument(fetcher, candidate, signal);
    if (doc === undefined) continue;
    // Root fallback is the metadata for the origin, not for the nested endpoint.
    const expected = location !== undefined ? requestUrl : candidate === root && locations.length > 1 ? url.origin : resource;
    if (doc['resource'] !== expected) fail('prm-resource-mismatch');
    prm = { ...doc, resource: expected };
    break;
  }
  const issuers = [...new Set(strings(prm?.['authorization_servers']))];
  if (!prm || !issuers.length) fail('prm-invalid');
  const selected = await options.chooseAuthorizationServer?.(Object.freeze([...issuers]));
  if (selected !== undefined && !issuers.includes(selected)) fail('as-selection-invalid');
  let lastError: AuthError | undefined;
  for (const issuer of selected === undefined ? issuers : [selected]) {
    try { return { resource: prm.resource, metadata: await discoverIssuer(fetcher, issuer, options, signal), scopes: strings(prm['scopes_supported']) }; }
    catch (error) { if (!(error instanceof AuthError)) throw error; lastError = error; }
  }
  throw lastError ?? new AuthError('auth-failure', 'as-metadata-missing');
}

export async function discoverIssuer(fetcher: FetchPort, issuer: string, options: DiscoveryOptions, signal: AbortSignal): Promise<Metadata> {
  const url = secureUrl(issuer, options.allowInsecureDev);
  if (url.search || url.hash || /[?#]/u.test(issuer)) fail('as-issuer-invalid');
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
  const candidates = [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`];
  if (path) candidates.push(`${url.origin}${path}/.well-known/openid-configuration`);
  for (const candidate of candidates) {
    const doc = await getDocument(fetcher, candidate, signal);
    if (!doc) continue;
    if (doc['issuer'] !== issuer) fail('as-issuer-mismatch');
    if (!strings(doc['code_challenge_methods_supported']).includes('S256')) fail('pkce-s256-required');
    const authorizationEndpoint = secureUrl(doc['authorization_endpoint'] as string, options.allowInsecureDev);
    const tokenEndpoint = secureUrl(doc['token_endpoint'] as string, options.allowInsecureDev);
    if (authorizationEndpoint.hash || tokenEndpoint.hash) fail('invalid-url');
    let registrationEndpoint: URL | undefined;
    if (doc['registration_endpoint'] !== undefined) {
      try {
        if (typeof doc['registration_endpoint'] !== 'string') fail('invalid-url');
        registrationEndpoint = secureUrl(doc['registration_endpoint'] as string, options.allowInsecureDev);
        if (registrationEndpoint.hash) fail('invalid-url');
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        registrationEndpoint = undefined;
        options.onDiagnostic?.(`ignoring invalid registration_endpoint: ${error.message}`);
      }
    }
    return { issuer, authorizationEndpoint, tokenEndpoint, ...(registrationEndpoint ? { registrationEndpoint } : {}),
      cimd: doc['client_id_metadata_document_supported'] === true,
      responseIssuer: doc['authorization_response_iss_parameter_supported'] === true,
      scopes: strings(doc['scopes_supported']),
      clientAuthMethods: strings(doc['token_endpoint_auth_methods_supported']),
    };
  }
  return fail('as-metadata-missing');
}
