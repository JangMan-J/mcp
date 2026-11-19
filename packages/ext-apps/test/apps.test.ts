import { expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionRegistry } from '@mcp-client/core';

it('EXT-apps-2 surfaces only nested app URIs', async () => {
  const {extractToolAppMeta} = await import('../src/index.js');
  expect(extractToolAppMeta({_meta:{ui:{resourceUri:'ui://example'}}})).toMatchObject({resourceUri:'ui://example'});
  expect(extractToolAppMeta({_meta:{ui:{resourceUri:'file:///example'}}})).toBeUndefined();
});

it('EXT-REG-1: import does not register; EXT-PORT-1: host controls renderer readiness', async () => {
  vi.resetModules();
  const { ExtensionRegistry: Registry } = await import('@mcp-client/core');
  const register = vi.spyOn(Registry.prototype, 'register');
  try {
    const {createAppsExtension} = await import('../src/index.js');
    expect(register).not.toHaveBeenCalled();
    const registry = new ExtensionRegistry();
    let ready = false;
    registry.register(createAppsExtension({renderer:{selfTest:()=>ready,render(){}}}));
    expect(registry.capabilities()).toEqual({});
    ready = true;
    expect(registry.capabilities()).toEqual({extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}});
    expect(createAppsExtension().settings()).toBeUndefined();
  } finally { register.mockRestore(); }
});

it('EXT-apps-BRIDGE: renderer bridge is host-owned', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  for(const file of readdirSync(src,{recursive:true,withFileTypes:true})) if(file.isFile()) {
    expect(readFileSync(join(file.parentPath,file.name),'utf8')).not.toMatch(/iframe|postMessage/);
  }
});

const fixtures = fileURLToPath(new URL('../../fixtures/exchanges/ext/apps/',import.meta.url));
for(const file of readdirSync(fixtures).filter(f=>f.endsWith('.exchange.json'))) {
  const fx = JSON.parse(readFileSync(join(fixtures,file),'utf8'));
  it(fx.id, async () => {
    const {runExchange, ObservationMismatch} = await import('../src/conformance.js');
    await runExchange(fx);
    for(const m of fx.mutants) await expect(runExchange(fx,m)).rejects.toBeInstanceOf(ObservationMismatch);
  });
}
