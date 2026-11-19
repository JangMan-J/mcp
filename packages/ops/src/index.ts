import { CompletionApi } from "./completion.js";
import type { CapabilitySource, OpsClient } from "./common.js";
import { PromptsApi } from "./prompts.js";
import { ResourcesApi } from "./resources.js";
import { ToolsApi, type ToolHooks } from "./tools.js";
import type { SchemaValidator } from "./schema.js";

export * from "./common.js";
export * from "./schema.js";
export * from "./pagination.js";
export * from "./content.js";
export * from "./uri-template.js";
export * from "./icons.js";
export * from "./tools.js";
export * from "./prompts.js";
export * from "./resources.js";
export * from "./completion.js";

export interface OpsOptions {
  /** Server capabilities from server/discover, or a getter. Unknown (undefined) means call and map -32601. */
  readonly capabilities?: CapabilitySource;
  readonly validator?: SchemaValidator;
  readonly serverTrusted?: boolean;
  readonly hooks?: ToolHooks;
}

export interface Ops {
  readonly tools: ToolsApi;
  readonly prompts: PromptsApi;
  readonly resources: ResourcesApi;
  readonly completion: CompletionApi;
}

export function createOps(client: OpsClient, opts: OpsOptions = {}): Ops {
  const caps = { ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}) };
  return {
    tools: new ToolsApi(client, {
      ...caps,
      ...(opts.validator ? { validator: opts.validator } : {}),
      ...(opts.serverTrusted !== undefined ? { serverTrusted: opts.serverTrusted } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
    }),
    prompts: new PromptsApi(client, caps),
    resources: new ResourcesApi(client, caps),
    completion: new CompletionApi(client, caps),
  };
}
