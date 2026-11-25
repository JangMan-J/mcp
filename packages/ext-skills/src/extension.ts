import type { Extension, ExtensionCapabilities } from "@mcp/core";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const SKILLS_REVISION = "2026-10-30";

export interface SkillsExtensionOptions {
  readonly healthy?: boolean;
}

export class SkillsExtension implements Extension {
  readonly id = SKILLS_EXTENSION_ID;
  readonly version = SKILLS_REVISION;
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

  capabilities(isWorking = true): ExtensionCapabilities {
    if (!isWorking || this.health() !== "working") {
      return {};
    }
    return {
      extensions: {
        [SKILLS_EXTENSION_ID]: {},
      },
    };
  }
}

export function createSkillsExtension(opts?: SkillsExtensionOptions): SkillsExtension {
  return new SkillsExtension(opts);
}
