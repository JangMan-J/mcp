import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ExchangeStep =
  | {
      readonly do: "call";
      readonly as: string;
      readonly method: string;
      readonly params?: Record<string, unknown>;
      readonly idempotent?: boolean;
      readonly abortBeforeSend?: boolean;
    }
  | {
      readonly expect: "wire";
      readonly index?: number;
      readonly match?: Record<string, unknown>;
      readonly capture?: Record<string, string>;
    }
  | {
      readonly server: "result" | "error";
      readonly for?: string;
      readonly id?: string | number;
      readonly result?: Record<string, unknown>;
      readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
    }
  | {
      readonly do: "abort";
      readonly target: string;
    }
  | {
      readonly advance: number;
    };

export interface ExchangeFixture {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly pin: "tag" | "wiki" | "sep-pr-head" | "ext-page";
  readonly source: readonly string[];
  readonly tier: "A" | "B";
  readonly binding: "stdio" | "http" | "any";
  readonly server?: {
    readonly capabilities?: Record<string, unknown>;
    readonly era?: "modern" | "legacy-silent" | "legacy-error" | "noisy";
  };
  readonly client?: {
    readonly setup?: {
      readonly timeoutMs?: number;
      readonly supportedVersions?: readonly string[];
    };
    readonly clock?: "fake" | "realtime";
  };
  readonly script: readonly ExchangeStep[];
  readonly expect: {
    readonly outcome?: Record<string, Record<string, unknown>>;
    readonly wire?: {
      readonly distinctIds?: boolean;
      readonly count?: Record<string, number>;
      readonly totalRequests?: number;
      readonly never?: readonly string[];
    };
  };
  readonly mutants: readonly string[];
}

export function loadExchangeFiles(dir: string): ExchangeFixture[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".exchange.json")) files.push(p);
    }
  };
  walk(dir);
  return files.map((file) => JSON.parse(readFileSync(file, "utf8")) as ExchangeFixture);
}
