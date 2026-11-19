import type { Outcome } from "./outcome.js";

export interface Disposable {
  dispose(): void;
}

export interface ExtensionCapabilities {
  readonly [namespace: string]: Record<string, unknown>;
}

export interface ExtensionHost {
  registerResultType(resultType: string, handler: (result: Record<string, unknown>) => Outcome<unknown>): Disposable;
}

export interface Extension {
  readonly id: string;
  readonly version?: string;
  capabilities(isWorking: boolean): ExtensionCapabilities;
  attach(host: ExtensionHost): Disposable;
}

export class ExtensionRegistry {
  private readonly extensions = new Map<string, { ext: Extension; detacher: Disposable }>();
  private readonly resultTypes = new Map<string, (result: Record<string, unknown>) => Outcome<unknown>>();

  register(ext: Extension): Disposable {
    if (this.extensions.has(ext.id)) {
      throw new Error(`Extension already registered: ${ext.id}`);
    }
    const ownedResultTypes: string[] = [];
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
            this.resultTypes.delete(resultType);
          },
        };
      },
    };
    const detacher = ext.attach(host);
    this.extensions.set(ext.id, { ext, detacher });
    return {
      dispose: () => {
        const entry = this.extensions.get(ext.id);
        if (!entry) return;
        this.extensions.delete(ext.id);
        for (const rt of ownedResultTypes) {
          this.resultTypes.delete(rt);
        }
        entry.detacher.dispose();
      },
    };
  }

  capabilities(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const { ext } of this.extensions.values()) {
      Object.assign(merged, ext.capabilities(true));
    }
    return merged;
  }

  resolveResultType(resultType: string): ((result: Record<string, unknown>) => Outcome<unknown>) | undefined {
    return this.resultTypes.get(resultType);
  }

  closeAllReverse(): void {
    const entries = Array.from(this.extensions.values()).reverse();
    this.extensions.clear();
    this.resultTypes.clear();
    for (const { detacher } of entries) {
      detacher.dispose();
    }
  }
}
