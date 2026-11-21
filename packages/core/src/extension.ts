import type { JsonRpcNotification, JsonRpcRequest } from "./jsonrpc.js";
import type { Outcome } from "./outcome.js";

export interface Disposable {
  dispose(): void;
}

export interface ExtensionCapabilities {
  readonly [namespace: string]: Record<string, unknown>;
}

export type ExtensionNotificationHandler = (notification: JsonRpcNotification) => void;
export type ExtensionRequestHandler = (request: JsonRpcRequest) => unknown;

export interface ExtensionHost {
  registerResultType(resultType: string, handler: (result: Record<string, unknown>) => Outcome<unknown>): Disposable;
  onNotification?(method: string, handler: ExtensionNotificationHandler): Disposable;
  onRequest?(method: string, handler: ExtensionRequestHandler): Disposable;
}

export interface Extension {
  readonly id: string;
  readonly version?: string;
  capabilities?(isWorking: boolean): ExtensionCapabilities;
  attach?(host: ExtensionHost): Disposable;
}

interface RegisteredExtension {
  readonly ext: Extension;
  readonly detacher: Disposable;
  readonly cleanup: () => void;
}

export class ExtensionRegistry {
  private readonly extensions = new Map<string, RegisteredExtension>();
  private readonly resultTypes = new Map<string, (result: Record<string, unknown>) => Outcome<unknown>>();
  private readonly notificationHandlers = new Map<string, Set<ExtensionNotificationHandler>>();
  private readonly requestHandlers = new Map<string, ExtensionRequestHandler>();

  register(ext: Extension): Disposable {
    if (this.extensions.has(ext.id)) {
      throw new Error(`Extension already registered: ${ext.id}`);
    }
    const ownedResultTypes: string[] = [];
    const ownedNotifications: Array<{ method: string; handler: ExtensionNotificationHandler }> = [];
    const ownedRequests: string[] = [];

    const cleanup = () => {
      for (const rt of ownedResultTypes) {
        this.resultTypes.delete(rt);
      }
      for (const { method, handler } of ownedNotifications) {
        const set = this.notificationHandlers.get(method);
        if (set) {
          set.delete(handler);
          if (set.size === 0) this.notificationHandlers.delete(method);
        }
      }
      for (const method of ownedRequests) {
        this.requestHandlers.delete(method);
      }
    };

    const host: ExtensionHost = {
      registerResultType: (resultType, handler) => {
        if (resultType === "complete" || resultType === "input_required") {
          throw new Error(`Cannot override core resultType: ${resultType}`);
        }
        if (this.resultTypes.has(resultType)) {
          throw new Error(`Duplicate extension resultType: ${resultType}`);
        }
        this.resultTypes.set(resultType, handler);
        ownedResultTypes.push(resultType);
        return {
          dispose: () => {
            if (this.resultTypes.get(resultType) === handler) {
              this.resultTypes.delete(resultType);
            }
          },
        };
      },
      onNotification: (method, handler) => {
        let set = this.notificationHandlers.get(method);
        if (!set) {
          set = new Set();
          this.notificationHandlers.set(method, set);
        }
        set.add(handler);
        ownedNotifications.push({ method, handler });
        return {
          dispose: () => {
            const cur = this.notificationHandlers.get(method);
            if (!cur) return;
            cur.delete(handler);
            if (cur.size === 0) this.notificationHandlers.delete(method);
          },
        };
      },
      onRequest: (method, handler) => {
        if (this.requestHandlers.has(method)) {
          throw new Error(`Duplicate extension request handler: ${method}`);
        }
        this.requestHandlers.set(method, handler);
        ownedRequests.push(method);
        return {
          dispose: () => {
            if (this.requestHandlers.get(method) === handler) {
              this.requestHandlers.delete(method);
            }
          },
        };
      },
    };

    let detacher: Disposable;
    try {
      detacher = ext.attach ? ext.attach(host) : { dispose() {} };
    } catch (err) {
      cleanup();
      throw err;
    }

    this.extensions.set(ext.id, { ext, detacher, cleanup });
    return {
      dispose: () => {
        const entry = this.extensions.get(ext.id);
        if (!entry) return;
        this.extensions.delete(ext.id);
        entry.cleanup();
        entry.detacher.dispose();
      },
    };
  }

  capabilities(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const { ext } of this.extensions.values()) {
      if (!ext.capabilities) continue;
      const caps = ext.capabilities(true);
      const prev = merged.extensions as Record<string, unknown> | undefined;
      Object.assign(merged, caps);
      // The standard `extensions` namespace is a map keyed by extension ID: merge by subkey into a fresh object.
      if (Object.prototype.hasOwnProperty.call(caps, "extensions")) {
        merged.extensions = { ...prev, ...caps.extensions };
      }
    }
    return merged;
  }

  resolveResultType(resultType: string): ((result: Record<string, unknown>) => Outcome<unknown>) | undefined {
    return this.resultTypes.get(resultType);
  }

  dispatchNotification(notification: JsonRpcNotification, onError?: (err: unknown) => void): void {
    const set = this.notificationHandlers.get(notification.method);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(notification);
      } catch (err) {
        onError?.(err);
      }
    }
  }

  resolveRequestHandler(method: string): ExtensionRequestHandler | undefined {
    return this.requestHandlers.get(method);
  }

  closeAllReverse(): void {
    const entries = Array.from(this.extensions.values()).reverse();
    this.extensions.clear();
    this.resultTypes.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
    for (const { detacher } of entries) {
      detacher.dispose();
    }
  }
}
