import { expect, it } from "vitest";
import { McpClient, type FetchPort } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";
import { OAuthAuthorization } from "../src/index.js";

const resource = "https://resource.test/mcp";
const prm = "https://resource.test/metadata";
const issuer = "https://issuer.test";
const asMetadata = `${issuer}/.well-known/oauth-authorization-server`;

async function challenge(header: string, documents: Readonly<Record<string, unknown>>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchPort: FetchPort = {
    async fetch(url, init) {
      calls.push({ url, method: init.method ?? "GET" });
      if (url === resource) return new Response(null, { status: 401, headers: { "www-authenticate": header } });
      return Object.hasOwn(documents, url) ? Response.json(documents[url]) : new Response(null, { status: 404 });
    },
  };
  const authProvider = new OAuthAuthorization({ resource, redirectUri: "https://client.test/callback", fetch: fetchPort });
  const transport = new HttpTransport({ url: resource, fetchPort, authProvider });
  const client = new McpClient({ transport, server: { key: "oauth-edge" } });
  try {
    return { outcome: await client.request("tools/list"), calls };
  } finally {
    await client.close();
  }
}

it("[EDGE-30] rejects a Basic-only challenge as unsupported without OAuth discovery", async () => {
  const { outcome, calls } = await challenge('Basic realm="tools"', {});
  expect(outcome).toMatchObject({ kind: "auth-failure", detail: { reason: "unsupported-scheme", status: 401 } });
  expect(calls).toEqual([{ url: resource, method: "POST" }]);
});

it("[EDGE-31] reports no registration mechanism instead of using the advertised DCR endpoint", async () => {
  const { outcome, calls } = await challenge(`Bearer resource_metadata="${prm}"`, {
    [prm]: { resource, authorization_servers: [issuer] },
    [asMetadata]: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      code_challenge_methods_supported: ["S256"],
      registration_endpoint: `${issuer}/register`,
      client_id_metadata_document_supported: false,
    },
  });
  expect(outcome).toMatchObject({ kind: "auth-failure", detail: { reason: "no-registration-mechanism", status: 401 } });
  expect(calls).toEqual([
    { url: resource, method: "POST" },
    { url: prm, method: "GET" },
    { url: asMetadata, method: "GET" },
  ]);
});
