export type BearerChallenge = Readonly<Partial<Record<'resource_metadata' | 'scope' | 'error' | 'error_description' | 'error_uri', string>>>;
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quotedString = String.raw`"(?:[^"\\\x00-\x1f\x7f]|\\[\x20-\x7e])*"`;
const param = new RegExp(`^(${token})[ \\t]*=[ \\t]*(${token}|${quotedString})$`, 'u');
const scheme = new RegExp(`^(${token})(?:[ \\t]+(.+))?$`, 'u');

/** Parse each field independently; a malformed field cannot supply a partial challenge. */
export function parseBearerChallenges(input: string | readonly string[]): BearerChallenge[] {
  return (typeof input === 'string' ? [input] : input).flatMap((line) => {
    const pieces: string[] = [];
    let quote = false, escape = false, start = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escape) { escape = false; continue; }
      if (quote && ch === '\\') escape = true;
      else if (ch === '"') quote = !quote;
      else if (!quote && ch === ',') { pieces.push(line.slice(start, i)); start = i + 1; }
    }
    if (quote) return [];
    pieces.push(line.slice(start));
    const result: BearerChallenge[] = [];
    let entry: Record<string, string> | undefined, bearer = false, acceptsParams = false;
    for (const raw of pieces) {
      const piece = raw.trim();
      if (!piece) continue;
      let match = param.exec(piece);
      if (!match) {
        const next = scheme.exec(piece);
        if (!next) return [];
        entry = Object.create(null) as Record<string, string>;
        bearer = next[1]?.toLowerCase() === 'bearer';
        if (bearer) result.push(entry);
        acceptsParams = false;
        if (next[2] === undefined) continue;
        match = param.exec(next[2]);
        if (!match) {
          if (!bearer && /^[a-z\d._~+/=-]+$/iu.test(next[2])) continue;
          return [];
        }
        acceptsParams = true;
      }
      if (!entry || !acceptsParams) return [];
      const key = match[1]!.toLowerCase(), value = match[2]!;
      if (Object.hasOwn(entry, key)) return [];
      entry[key] = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/gu, '$1') : value;
    }
    return result.map(({ resource_metadata, scope, error, error_description, error_uri }) => Object.fromEntries(
      Object.entries({ resource_metadata, scope, error, error_description, error_uri }).filter(([, v]) => v !== undefined),
    ));
  });
}
