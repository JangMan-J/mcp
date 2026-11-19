import type { Disposable, Extension, ExtensionCapabilities, ExtensionHost } from "@mcp-client/core";
import { isConfigured, type ClientCredentialsConfig } from "./config.js";

export const CLIENT_CREDENTIALS_EXTENSION_ID = "io.modelcontextprotocol/oauth-client-credentials";

export const CLIENT_CREDENTIALS_PIN = Object.freeze({
  upstream: "modelcontextprotocol/ext-auth",
  commit: "15ca394e00a66434520b9ade26294999295a43ae",
  path: "specification/stable/oauth-client-credentials/2026-07-28/oauth-client-credentials.mdx",
  coreSpec: "2026-07-28",
});

export class ClientCredentialsExtension implements Extension {
  readonly id = CLIENT_CREDENTIALS_EXTENSION_ID;
  readonly stage = "stable" as const;
  readonly defaultEnabled = false as const;
  readonly pin = CLIENT_CREDENTIALS_PIN;

  constructor(private readonly config: ClientCredentialsConfig = {}) {}

  health(): "working" | "unavailable" {
    return isConfigured(this.config) ? "working" : "unavailable";
  }

  settings(): Record<string, never> | undefined {
    return this.health() === "working" ? {} : undefined;
  }

  capabilities(isWorking: boolean): ExtensionCapabilities {
    return isWorking && this.health() === "working" ? { extensions: { [this.id]: {} } } : {};
  }

  /** Registers nothing: the extension only supplies an AuthProvider and a capability. */
  attach(_host: ExtensionHost): Disposable {
    return { dispose() {} };
  }
}

export function createClientCredentialsExtension(config: ClientCredentialsConfig = {}): ClientCredentialsExtension {
  return new ClientCredentialsExtension(config);
}
