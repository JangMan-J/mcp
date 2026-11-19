export interface AuthHeaderResult {
  readonly authorization: string;
  readonly contextId: string;
}

export interface AuthChallenge {
  readonly status: 401 | 403;
  readonly wwwAuthenticate?: string;
  readonly resource?: string;
  readonly operation?: string;
}

export interface AuthProvider {
  /** Stable identifier for the current grant/credential context (never raw token). */
  contextId(): string;
  /** Produce bearer header for a request without leaking raw token outside headers. */
  headerFor(url: string, operation?: string): Promise<AuthHeaderResult | undefined>;
  /** Handle 401/403 challenge; returns true if credentials refreshed/stepped up and retry is warranted. */
  onChallenge?(challenge: AuthChallenge, signal: AbortSignal): Promise<boolean>;
}
