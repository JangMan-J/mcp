import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "adapters/pi/test/**/*.test.ts"],
    environment: "node",
  },
});
