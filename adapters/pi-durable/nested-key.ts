export function nestedCallKey(parent: string, child: { position: number } | { key: string }): string {
  if ('key' in child) return JSON.stringify([parent, 'key', child.key]);

  // JSON numbers lose signed zero and turn non-finite values into null.
  const position = Object.is(child.position, -0) ? '-0' : String(child.position);
  return JSON.stringify([parent, 'position', position]);
}
