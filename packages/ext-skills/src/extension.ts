import type { Disposable, Extension, ExtensionCapabilities, ExtensionHost } from "@mcp-client/core";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export const SKILLS_PIN = {
  repo: "modelcontextprotocol/ext-skills",
  commit: "649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a",
  date: "2026-10-30",
  spec: "specification/beta/skills.mdx",
  stage: "beta" as const,
  wiki: "extensions/skills/overview.md",
  wikiCommit: "de3550c9fea3c5269e42ac95204eef44a2b2cb92",
} as const;

export interface SkillsExtensionOptions {
  readonly healthy?: boolean;
}

export class SkillsExtension implements Extension {
  readonly id = SKILLS_EXTENSION_ID;
  readonly version = SKILLS_PIN.date;
  readonly stage = "beta" as const;
  readonly defaultEnabled = false as const;
  readonly pin = SKILLS_PIN;
  private readonly healthy: boolean;

  constructor(opts: SkillsExtensionOptions = {}) {
    this.healthy = opts.healthy !== false;
  }

  health(): "working" | "unhealthy" {
    return this.healthy ? "working" : "unhealthy";
  }

  settings(): Record<string, unknown> | undefined {
    return this.health() === "working" ? {} : undefined;
  }

  capabilities(isWorking: boolean): ExtensionCapabilities {
    if (!isWorking || this.health() !== "working") {
      return {};
    }
    return {
      extensions: {
        [SKILLS_EXTENSION_ID]: {},
      },
    };
  }

  attach(_host: ExtensionHost): Disposable {
    return { dispose() {} };
  }
}

export function createSkillsExtension(opts?: SkillsExtensionOptions): SkillsExtension {
  return new SkillsExtension(opts);
}
