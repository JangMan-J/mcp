import { describe, expect, it } from "vitest";
import { ExtensionRegistry, type Extension, type ExtensionCapabilities } from "../src/extension.js";

function ext(id: string, caps: ExtensionCapabilities, onDispose: () => void = () => {}): Extension {
  return {
    id,
    capabilities: () => caps,
    attach: () => ({ dispose: onDispose }),
  };
}

describe("ExtensionRegistry.capabilities", () => {
  it("merges the extensions map by subkey across independent extensions", () => {
    const reg = new ExtensionRegistry();
    const aCaps = { extensions: { "io.a/events": { v: 1 } }, tools: { a: true } };
    const bCaps = { extensions: { "io.b/tasks": {} }, tools: { b: true } };
    reg.register(ext("a", aCaps));
    reg.register(ext("b", bCaps));
    const caps = reg.capabilities();
    expect(caps.extensions).toEqual({ "io.a/events": { v: 1 }, "io.b/tasks": {} });
    // Non-`extensions` namespaces keep top-level last-wins semantics.
    expect(caps.tools).toEqual({ b: true });
    // Plugin-returned objects are not mutated.
    expect(aCaps.extensions).toEqual({ "io.a/events": { v: 1 } });
    expect(bCaps.extensions).toEqual({ "io.b/tasks": {} });
  });

  it("does not hand out the plugin's own extensions object", () => {
    const reg = new ExtensionRegistry();
    const aCaps = { extensions: { "io.a/events": {} } };
    reg.register(ext("a", aCaps));
    const caps = reg.capabilities();
    expect(caps.extensions).toEqual(aCaps.extensions);
    expect(caps.extensions).not.toBe(aCaps.extensions);
  });

  it("keeps extensions from an earlier extension when a later one has none", () => {
    const reg = new ExtensionRegistry();
    reg.register(ext("a", { extensions: { "io.a/events": {} } }));
    reg.register(ext("b", { tools: {} }));
    expect(reg.capabilities()).toEqual({ extensions: { "io.a/events": {} }, tools: {} });
  });

  it("dispose removes only that extension and detaches exactly once", () => {
    const reg = new ExtensionRegistry();
    let aDisposed = 0;
    let bDisposed = 0;
    const a = reg.register(ext("a", { extensions: { "io.a/events": {} } }, () => aDisposed++));
    reg.register(ext("b", { extensions: { "io.b/tasks": {} } }, () => bDisposed++));
    a.dispose();
    a.dispose();
    expect(aDisposed).toBe(1);
    expect(bDisposed).toBe(0);
    expect(reg.capabilities()).toEqual({ extensions: { "io.b/tasks": {} } });
    reg.closeAllReverse();
    expect(aDisposed).toBe(1);
    expect(bDisposed).toBe(1);
    expect(reg.capabilities()).toEqual({});
  });
});
