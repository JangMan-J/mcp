import { expect, it } from 'vitest';
import { nestedCallKey } from './nested-key.js';

it('keeps positional siblings distinct and stable on replay', () => {
  const first = nestedCallKey('run', { position: 0 });
  expect(nestedCallKey('run', { position: 1 })).not.toBe(first);
  expect(nestedCallKey('other', { position: 0 })).not.toBe(first);
  expect(nestedCallKey('run', { key: '0' })).not.toBe(first);
  expect(nestedCallKey('run', { position: 0 })).toBe(first);
});

it('keeps an explicit key stable across reordering, but only within its parent', () => {
  const moved = { key: '', position: 9 };
  const original = nestedCallKey('parent', { key: '' });
  expect(nestedCallKey('parent', moved)).toBe(original);
  expect(nestedCallKey('other', moved)).not.toBe(original);
});

it('preserves boundaries even when components contain tuple punctuation', () => {
  const left = nestedCallKey('x","key","y', { key: 'z' });
  expect(nestedCallKey('x', { key: 'y","key","z' })).not.toBe(left);
});
