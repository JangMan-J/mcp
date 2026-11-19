import type { ConsentPort, Disposable, Extension, ExtensionCapabilities, ExtensionHost, Outcome, RequestOptions } from '@mcp-client/core';
import { isObj, local, type Ops, type ResourceReadResult, type ToolCallOptions, type ToolCallResult } from '@mcp-client/ops';

export const APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const APPS_PIN = {
  repo: 'modelcontextprotocol/ext-apps', commit: 'ea3e9d0e624a20bc1c51310292f09d9b8ed17161',
  spec: 'specification/2026-01-26/apps.mdx', stage: 'stable',
} as const;

export interface AppResourceMeta {
  readonly resourceUri: string;
  readonly csp?: unknown;
  readonly permissions?: unknown;
}
export interface AppViewPayload extends AppResourceMeta {
  readonly toolName?: string;
  readonly mimeType: string;
  readonly text: string;
}
export interface AppRenderPort {
  selfTest?(): boolean;
  render(view: AppViewPayload): void | Promise<void>;
}
export interface AppsExtensionOptions { readonly renderer?: AppRenderPort; readonly healthy?: boolean }
export class AppsExtension implements Extension {
  readonly id = APPS_EXTENSION_ID;
  readonly pin = APPS_PIN;
  readonly stage = 'stable' as const;
  readonly defaultEnabled = false as const;
  constructor(private readonly opts: AppsExtensionOptions = {}) {}
  health(): 'working' | 'unavailable' {
    const { healthy, renderer } = this.opts;
    if (healthy === false || !renderer) return 'unavailable';
    try { return !renderer.selfTest || renderer.selfTest() === true ? 'working' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  settings() { return this.health() === 'working' ? { mimeTypes: [MCP_APP_MIME_TYPE] } : undefined; }
  capabilities(isWorking: boolean): ExtensionCapabilities {
    const settings = isWorking && this.settings();
    return settings ? { extensions: { [this.id]: settings } } : {};
  }
  attach(_host: ExtensionHost): Disposable { return { dispose() {} }; }
}
export function createAppsExtension(opts?: AppsExtensionOptions) { return new AppsExtension(opts); }

function uiMetadata(item: Record<string, unknown>) {
  const meta = item['_meta'];
  return isObj(meta) && isObj(meta['ui']) ? meta['ui'] : {};
}
export function extractToolAppMeta(tool: Record<string, unknown>): AppResourceMeta | undefined {
  const { resourceUri, csp, permissions } = uiMetadata(tool);
  return typeof resourceUri === 'string' && resourceUri.startsWith('ui://') ? { resourceUri, csp, permissions } : undefined;
}

export interface AppsClientOptions {
  readonly ops: Ops;
  readonly renderer?: AppRenderPort;
  readonly consent?: ConsentPort;
  readonly serverLabel: string;
}
export class AppsClient {
  constructor(private readonly ports: AppsClientOptions) {}
  listTools(opts?: RequestOptions & { readonly cursor?: string }) { return this.ports.ops.tools.list(opts); }

  async loadAppResource(metaOrUri: AppResourceMeta | string, opts?: RequestOptions & { toolName?: string }): Promise<Outcome<AppViewPayload>> {
    const tool = typeof metaOrUri === 'string' ? { resourceUri: metaOrUri } : metaOrUri;
    const { resourceUri } = tool;
    const method = 'resources/read';
    if (!resourceUri.startsWith('ui://')) return local('invalid-arguments', method, { reason: 'invalid-app-uri' });
    const { renderer } = this.ports;
    if (!renderer) return local('local-error', method, { reason: 'renderer-unavailable' });
    const { toolName, ...ro } = opts ?? {};
    const render = async (out: Outcome<ResourceReadResult>): Promise<Outcome<AppViewPayload>> => {
      if (out.kind === 'mrtr-interim') return { ...out, resume: async responses => render(await out.resume(responses)) };
      if (out.kind !== 'ok') return out;
      const entry = out.value.contents.find(c => c.uri === resourceUri);
      if (entry?.mimeType !== MCP_APP_MIME_TYPE) return { kind: 'protocol-violation', detail: { reason: 'invalid-app-mime', mimeType: entry?.mimeType }, meta: out.meta };
      if (typeof entry.text !== 'string') return { kind: 'protocol-violation', detail: { reason: 'invalid-app-text' }, meta: out.meta };
      // Content-specific policy takes precedence over result and tool defaults, field by field.
      const policy = { ...tool, ...uiMetadata(out.value.raw), ...uiMetadata(entry.raw) };
      const view = { resourceUri, text: entry.text, mimeType: entry.mimeType, csp: policy['csp'], permissions: policy['permissions'], ...(toolName !== undefined ? { toolName } : {}) };
      try { await renderer.render(view); }
      catch { return { kind: 'local-error', detail: { reason: 'render-failed' }, meta: out.meta }; }
      return { kind: 'ok', value: view, meta: out.meta };
    };
    return render(await this.ports.ops.resources.read(resourceUri, ro));
  }

  async callToolFromApp(name: string, args?: unknown, opts?: ToolCallOptions): Promise<Outcome<ToolCallResult>> {
    const { consent, serverLabel, ops } = this.ports;
    try {
      const result = await consent?.request({ kind: 'tool-call', serverLabel, message: `Call tool ${name}?` }, opts?.signal ?? new AbortController().signal);
      if (result?.decision !== 'accept') return local('local-error', 'tools/call', { reason: 'consent-required' });
    } catch { return local('local-error', 'tools/call', { reason: 'consent-failed' }); }
    return ops.tools.call(name, args, opts);
  }
}
