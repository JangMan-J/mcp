import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "@mcp/core";
import { expect, it } from "vitest";
import { StdioTransport } from "../src/index.js";

it("[EDGE-35] diagnoses an unsolicited server ping without writing any reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "edge-server-ping-"));
  const log = join(dir, "wire.log");
  const server = fileURLToPath(new URL("./helpers/stdio-server.ts", import.meta.url));
  const transport = new StdioTransport({
    command: process.execPath,
    args: ["--no-warnings", "--experimental-strip-types", server, "--log", log, "--mode", "server-request"],
    graceMs: 150,
    termMs: 150,
  });
  const client = new McpClient({ transport, server: { key: "server-ping" } });
  try {
    await expect(Promise.resolve(client.request("tools/list"))).resolves.toMatchObject({
      kind: "ok", value: { afterServerReq: true },
    });
    await client.close();
    const wire = (await readFile(log, "utf8")).split("\n")
      .filter(line => line.startsWith("STDIN:")).map(line => JSON.parse(line.slice(6)));
    expect(wire).toEqual([expect.objectContaining({ jsonrpc: "2.0", id: expect.any(Number), method: "tools/list" })]);
    expect(transport.diagnosticsSnapshot()).toContainEqual(expect.objectContaining({
      kind: "violation", message: expect.stringContaining("server-initiated request ignored"),
    }));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
