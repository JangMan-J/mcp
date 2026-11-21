import { join } from "node:path";
import { homedir } from "node:os";
import { createPiMcpExtension, type PiExtensionAPI } from "./pi-extension.js";
import { createLiveAuth, createPiConsent } from "./live-auth.js";
import { createCoreFeatures } from "./core-features.js";
import { createEventFeatures } from "./event-features.js";
import { createExtendedFeatures, inspectServerCard } from "./extended-features.js";

export { createPiMcpExtension, createLiveMcpServerRuntime } from "./pi-extension.js";
export type { PiExtensionAPI, PiMcpExtensionOptions, PiFeatureHost, PiFeatureConnector, PiLiveAuth, LiveRuntimeOptions, LiveMcpServerRuntime } from "./pi-extension.js";

function isTrusted(ctx: any): boolean {
  try { return typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted() === true; } catch { return false; }
}

/** Default Pi entrypoint: live auth, Pi UI consent, and all feature modules. */
export default function piMcpExtension(pi: PiExtensionAPI): void {
  let ctx: any;
  const { consent, authorizationConsent } = createPiConsent(() => ctx);
  // Bearer tokens come from Pi's model registry; a missing key rejects instead of sending an empty bearer.
  const resolveProviderToken = async (provider: string): Promise<string> => {
    const key = await ctx?.modelRegistry?.getApiKeyForProvider?.(provider) as string | undefined;
    if (!key) throw new Error(`No API key available for provider "${provider}"`);
    return key;
  };
  const configDir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  const ext = createPiMcpExtension({
    configDir,
    consent,
    resolveProviderToken,
    onContext: (c) => { ctx = c; },
    // Project config is read only when Pi's ctx.isProjectTrusted() returns true; a missing or throwing check fails closed.
    project: () => {
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
      return cwd ? { configPath: join(cwd, ".pi", "mcp.json"), trusted: isTrusted(ctx) } : undefined;
    },
    // Branch state persists through Pi's session: appendEntry writes, the active branch is read back.
    branchStore: {
      appendEntry: (type, data) => { pi.appendEntry?.(type, data); },
      getBranch: () => ctx?.sessionManager?.getBranch?.() ?? [],
    },
    card: inspectServerCard,
    createAuth: (descriptor, { signal, credentialStore }) => createLiveAuth(descriptor, {
      authorizationConsent, resolveProviderToken, signal, credentials: credentialStore as never,
    }),
    features: [createCoreFeatures, createEventFeatures, createExtendedFeatures],
  });
  ext(pi);
}
