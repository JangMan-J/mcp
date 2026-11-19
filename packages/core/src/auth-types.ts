import type { ConsentPort } from "./ports.js";

export interface AuthRequestContext {
  readonly signal: AbortSignal;
  readonly consent?: ConsentPort;
  readonly serverLabel?: string;
}

/** A provider's structured, non-secret failure; never include peer or credential text in reason. */
export class AuthError extends Error {
  constructor(readonly kind: "auth-failure" | "auth-unavailable", readonly reason: string) {
    super(`${kind}/${reason}`);
    this.name = "AuthError";
  }
}

export interface AuthHeaderResult {
  readonly authorization: string;
  readonly contextId: string;
  /** Opaque identity of the credential used on the wire, unrelated to the cache partition. */
  readonly credentialVersion?: object;
}

export interface AuthChallenge {
  readonly status: 401 | 403;
  readonly wwwAuthenticate?: string;
  readonly resource?: string;
  readonly operation?: string;
  /** Null means no Authorization header was sent; undefined means no version was reported. */
  readonly credentialVersion?: object | null;
}

export interface AuthProvider {
  /** Stable identifier for the current grant/credential context (never raw token). */
  contextId(): string;
  /** Produce bearer header for a request without leaking raw token outside headers. */
  headerFor(url: string, operation?: string, context?: AuthRequestContext): Promise<AuthHeaderResult | undefined>;
  /** Maximum 403 replays in one exchange. Defaults to three. */
  readonly stepUpLimit?: number;
  /** Handle 401/403 challenge; returns true if credentials refreshed/stepped up and retry is warranted. */
  onChallenge?(challenge: AuthChallenge, signal: AbortSignal, context?: AuthRequestContext): Promise<boolean>;
}
