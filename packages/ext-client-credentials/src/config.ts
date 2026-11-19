import type { Clock, CredentialStore, FetchPort, RandomPort } from "@mcp-client/core";
import type { AssertionSigner } from "./signer.js";

export interface ClientCredentialsDiagnostic {
  readonly event: "token-acquired" | "token-failed" | "token-invalidated";
  /** Non-secret facts only: never a secret, assertion, signing key, or token. */
  readonly detail?: string;
}

export interface ClientCredentialsConfig {
  readonly resource?: string;
  readonly clientId?: string;
  readonly secret?: string;
  readonly credentialKey?: string;
  readonly credentials?: CredentialStore;
  readonly signer?: AssertionSigner;
  readonly expectedIssuer?: string;
  readonly scopes?: readonly string[];
  readonly fetch?: FetchPort;
  readonly clock?: Pick<Clock, "now">;
  readonly random?: RandomPort;
  readonly allowInsecureDev?: boolean;
  readonly onDiagnostic?: (event: ClientCredentialsDiagnostic) => void;
}

export function isConfigured(c: ClientCredentialsConfig): boolean {
  const hasSecret = (typeof c.secret === "string" && c.secret !== "") || (!!c.credentials && !!c.credentialKey);
  return !!c.resource && !!c.clientId && (hasSecret || !!c.signer);
}
