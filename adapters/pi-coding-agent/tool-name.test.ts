import { describe, expect, it } from 'vitest';
import { toolName } from './tool-name.js';

describe('toolName', () => {
  it('preserves common provider-safe names up to the exact limit', () => {
    expect(toolName('my-DB', 'read_file')).toBe('mcp__my-DB__read_file');
    const tool = 'x'.repeat(56);
    expect(toolName('s', tool)).toBe(`mcp__s__${tool}`);
  });

  it('distinguishes long pairs even when their readable prefixes match', () => {
    const prefix = 's'.repeat(80);
    const tool = 't'.repeat(80);
    const names = [toolName(prefix, tool), toolName(prefix + 'x', tool), toolName(prefix, tool + 'x')];
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^mcp__[A-Za-z0-9_-]{1,59}$/);
    expect(toolName(prefix, tool)).toBe(names[0]);
  });

  it('disambiguates punctuation, non-ASCII, and already-normalized text', () => {
    const names = ['a.b', 'a/b', 'a雪b', 'a_b'].map(server => toolName(server, 'read'));
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^mcp__[A-Za-z0-9_-]{1,59}$/);
  });

  it('distinguishes component boundaries', () => {
    expect(toolName('a__b', 'c')).not.toBe(toolName('a', 'b__c'));
    expect(toolName('a_', 'b')).not.toBe(toolName('a', '_b'));
  });
});
