import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installCodingAgentAdapter } from "./adapter.js";
import { BUILTIN_MCP, type Disposable, type McpCommandDefinition, type PiHostPort,
  type PiSessionEvent, type PiSessionHandler } from "./host.js";

class FakeHost implements PiHostPort {
  command: McpCommandDefinition | undefined;
  builtin = true;
  handlers = new Map<PiSessionEvent, PiSessionHandler>();

  registerCommand(_name: "mcp", command: McpCommandDefinition): Disposable {
    this.command = command;
    return { dispose: () => { this.command = undefined; } };
  }
  on(event: PiSessionEvent, handler: PiSessionHandler): Disposable {
    this.handlers.set(event, handler);
    return { dispose: () => { this.handlers.delete(event); } };
  }
  disableBuiltin(_id: typeof BUILTIN_MCP): Disposable {
    this.builtin = false;
    return { dispose: () => { this.builtin = true; } };
  }
  async run(args: string, signal?: AbortSignal) {
    if (!this.command) return this.builtin ? "built-in /mcp" : "no /mcp";
    const messages: string[] = [];
    await this.command.handler(args, { notify: message => messages.push(message), ...(signal && { signal }) });
    return messages.join("\n");
  }
  async emit(event: PiSessionEvent) {
    await this.handlers.get(event)?.({ notify() {} });
  }
}

const scratchDirs: string[] = [];
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "pica-adapter-"));
  scratchDirs.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("runs /mcp over a real scratch config/store and restores the built-in without rewriting legacy files", async () => {
  const configDir = await scratch();
  const path = join(configDir, "mcp.json");
  const legacyAuth = join(configDir, "mcp-auth.json");
  const config = '{ "mcpServers": { "docs": { "url": "https://example.invalid/mcp" }, "files": { "command": "fake", "enabled": false } } }\n';
  await writeFile(path, config);
  await writeFile(legacyAuth, "legacy data\n");
  const host = new FakeHost();
  const closeDocs = vi.fn();
  const closeFiles = vi.fn();
  const browser = { open: vi.fn(async () => {}) };
  const installed = installCodingAgentAdapter(host, {
    configDir, browser,
    async createClient({ descriptor, signal, trust, credentialStore }) {
      expect(trust).toBe(true);
      expect(descriptor.source).toBe("global");
      expect(signal.aborted).toBe(false);
      return { name: descriptor.name, signal, credentialStore, close: descriptor.name === "docs" ? closeDocs : closeFiles };
    },
    async signIn({ client, descriptor, signal, credentialStore, browser: givenBrowser }) {
      expect(client.name).toBe(descriptor.name);
      expect(signal.aborted).toBe(false);
      expect(credentialStore).toBe(client.credentialStore);
      await givenBrowser?.open("https://example.invalid/auth", signal);
      await credentialStore.set(client.name, "fake credential");
    },
  });
  try {
    expect(host.builtin).toBe(false);
    await host.emit("session_start");
    expect(await host.run("list")).toBe("docs: connected\nfiles: disabled");
    expect(await host.run("enable files")).toBe("files: connected");
    expect(await host.run("disable docs")).toBe("docs: disabled");
    expect(closeDocs).toHaveBeenCalledTimes(1);
    expect(closeFiles).not.toHaveBeenCalled();
    expect(await host.run("status files")).toBe("files: connected");
    expect(await host.run("sign-in files")).toBe("files: sign-in complete");
    expect(browser.open).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(configDir, "pi-mcp-client-credentials.json"), "utf8")))
      .toEqual({ files: "fake credential" });
    await host.emit("session_shutdown");
    expect(closeFiles).toHaveBeenCalledOnce();
    expect(await host.run("status files")).toBe("files: disconnected");
  } finally { installed.dispose(); }
  expect(await host.run("list")).toBe("built-in /mcp");
  expect(host.handlers.size).toBe(0);
  expect(await readFile(path, "utf8")).toBe(config);
  expect(await readFile(legacyAuth, "utf8")).toBe("legacy data\n");
});

it("ignores an untrusted project file and only passes trusted descriptors to the factory", async () => {
  const configDir = await scratch();
  const configPath = join(configDir, "project-mcp.json");
  const host = new FakeHost();
  const createClient = vi.fn(() => ({ close() {} }));
  await writeFile(configPath, "not even JSON");
  const untrusted = installCodingAgentAdapter(host, { configDir, project: { configPath, trusted: false }, createClient });
  try {
    await host.emit("session_start");
    expect(await host.run("list")).toBe("No MCP servers configured.");
    expect(createClient).not.toHaveBeenCalled();
  } finally { untrusted.dispose(); }

  await writeFile(configPath, '{"mcpServers":{"project":{"command":"fake","exposure":"deferred"}}}');
  const trusted = installCodingAgentAdapter(host, { configDir, project: { configPath, trusted: true }, createClient });
  try {
    await host.emit("session_start");
    expect(await host.run("status project")).toBe("project: connected");
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      trust: true, descriptor: expect.objectContaining({ source: "project", exposure: "deferred" }),
    }));
    await host.emit("session_shutdown");
  } finally { trusted.dispose(); }
});

it("aborts in-flight sign-in on shutdown even when the command supplies its own signal", async () => {
  const configDir = await scratch();
  await writeFile(join(configDir, "mcp.json"), '{"mcpServers":{"docs":{"command":"fake"}}}');
  const host = new FakeHost();
  const request = new AbortController();
  let started!: (signal: AbortSignal) => void;
  let finish!: () => void;
  const signingIn = new Promise<AbortSignal>(resolve => { started = resolve; });
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const close = vi.fn();
  const installed = installCodingAgentAdapter(host, {
    configDir,
    createClient: () => ({ close }),
    signIn({ signal }) {
      started(signal);
      return completion;
    },
  });
  try {
    await host.emit("session_start");
    const result = host.run("sign-in docs", request.signal);
    const signal = await signingIn;
    await host.emit("session_shutdown");
    expect(close).toHaveBeenCalledOnce();
    expect(request.signal.aborted).toBe(false);
    expect(signal.aborted).toBe(true);
    const rejected = expect(result).rejects.toBe(signal.reason);
    finish();
    await rejected;
  } finally { installed.dispose(); }
});
