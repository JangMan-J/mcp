#!/usr/bin/env node
// Wave 0 validator for docs/conformance/*.md (IMPLEMENTATION_PLAN.md 16.1).
// Usage: node scripts/check-conformance-docs.mjs [--wiki-root DIR] FILE...
//        node scripts/check-conformance-docs.mjs --self-test
// Wiki root: --wiki-root, else $WIKI_ROOT, else ~/vaults/JangsWiki/Wiki/mcp.
//
// Anchor syntax (cell 2): one or more refs separated by ";" or "<br>", each
//   [S/|W/]<page>.md#<heading>
// "S/" = <wiki>/specification/2026-07-28/, "W/" or no prefix = <wiki>/.
// <heading> is the literal heading text (case-insensitive, inline markup
// stripped) or its GitHub-style slug. Optional surrounding backticks allowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER = ['ID', 'Anchor (page#heading)', 'Role', 'Strength', 'Condition', 'Default', 'Disposition', 'Acceptance check', 'Open question'];
const ROLES = new Set(['C', 'S', 'B', 'host']);
const STRENGTHS = new Set(['MUST', 'MUST NOT', 'SHOULD', 'SHOULD NOT', 'MAY', 'derived', 'n/a']);
const DISPOSITIONS = new Set(['required', 'active-optional', 'conditional', 'deprecated', 'excluded', 'unresolved', 'out-of-scope']);
const SPEC_DIR = 'specification/2026-07-28';

export function defaultWikiRoot() {
  return process.env.WIKI_ROOT || path.join(os.homedir(), 'vaults/JangsWiki/Wiki/mcp');
}

export function splitRow(line) {
  let s = line.trim();
  if (!s.startsWith('|')) return null;
  s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function slug(h) {
  return h.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}
function plainHeading(h) {
  return h.replace(/\s+#+\s*$/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').trim();
}

const headingCache = new Map();
function headingsOf(file) {
  if (headingCache.has(file)) return headingCache.get(file);
  const lit = new Set(), slugs = new Set();
  let fence = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const t = plainHeading(m[1]);
    lit.add(t.toLowerCase());
    slugs.add(slug(t));
  }
  const r = { lit, slugs };
  headingCache.set(file, r);
  return r;
}

function checkAnchor(cell, wiki) {
  const errs = [];
  const refs = cell.split(/;|<br\s*\/?>/).map((x) => x.trim().replace(/^`+|`+$/g, '').trim()).filter(Boolean);
  if (!refs.length) return ['anchor is blank'];
  for (const ref of refs) {
    const i = ref.indexOf('#');
    if (i < 1 || i === ref.length - 1) { errs.push(`anchor "${ref}" is not page#heading`); continue; }
    let page = ref.slice(0, i).trim();
    const head = ref.slice(i + 1).trim();
    let base = wiki;
    if (page.startsWith('S/')) { base = path.join(wiki, SPEC_DIR); page = page.slice(2); }
    else if (page.startsWith('W/')) page = page.slice(2);
    const file = path.resolve(base, page);
    if (!file.startsWith(path.resolve(wiki) + path.sep) || !file.endsWith('.md') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errs.push(`anchor "${ref}": wiki page not found (${file})`); continue;
    }
    const { lit, slugs } = headingsOf(file);
    const h = plainHeading(head);
    if (!lit.has(h.toLowerCase()) && !slugs.has(h) && !slugs.has(slug(h))) errs.push(`anchor "${ref}": heading not found in page`);
  }
  return errs;
}

// Returns { errors: string[], ids: Map<id, "file:line"> contributions via seen }.
export function checkFile(file, wiki, seen) {
  const errors = [];
  const err = (ln, msg) => errors.push(`${file}${ln ? ':' + ln : ''}: ${msg}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { err(0, 'file missing'); return errors; }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) { err(0, 'file is empty'); return errors; }
  const lines = text.split('\n');
  let rows = 0, tables = 0;
  for (let i = 0; i < lines.length; i++) {
    const hdr = splitRow(lines[i]);
    if (!hdr || hdr.length !== HEADER.length || hdr.some((c, k) => c !== HEADER[k])) {
      // A table-looking first line that is near-miss header? Only flag when it looks like a conformance header.
      if (hdr && hdr[0] === 'ID') err(i + 1, `bad header: expected "| ${HEADER.join(' | ')} |"`);
      continue;
    }
    tables++;
    const sep = splitRow(lines[i + 1] ?? '');
    if (!sep || sep.length !== 9 || !sep.every((c) => /^:?-{3,}:?$/.test(c) || /^:?-+:?$/.test(c))) err(i + 2, 'missing or malformed separator row (9 cells)');
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      rows++;
      const ln = j + 1;
      const c = splitRow(lines[j]);
      if (c.length !== 9) { err(ln, `row has ${c.length} cells, expected 9`); continue; }
      const [id, anchor, role, strength, , , disp, acc, q] = c;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) err(ln, `bad ID "${id}"`);
      else if (seen.has(id)) err(ln, `duplicate ID "${id}" (first at ${seen.get(id)})`);
      else seen.set(id, `${file}:${ln}`);
      for (const e of checkAnchor(anchor, wiki)) err(ln, `${id}: ${e}`);
      if (!ROLES.has(role)) err(ln, `${id}: bad Role "${role}"`);
      if (!STRENGTHS.has(strength)) err(ln, `${id}: bad Strength "${strength}"`);
      if (!DISPOSITIONS.has(disp)) err(ln, `${id}: bad Disposition "${disp}"`);
      if (!acc) err(ln, `${id}: Acceptance check is blank`);
      if (q !== '' && !/^Q\d+$/.test(q)) err(ln, `${id}: Open question must be empty or Q<number>, got "${q}"`);
    }
    i = j - 1;
  }
  if (!tables && !errors.length) err(0, 'no conformance table with the exact header found');
  else if (tables && !rows) err(0, 'table has no rows');
  return errors;
}

export function run(files, wiki) {
  const errors = [];
  if (!files.length) return ['no files given'];
  if (!fs.existsSync(wiki) || !fs.statSync(wiki).isDirectory()) return [`wiki root not found: ${wiki}`];
  const seen = new Map();
  for (const f of files) errors.push(...checkFile(f, wiki, seen));
  return errors;
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-'));
  const wiki = path.join(tmp, 'wiki');
  fs.mkdirSync(path.join(wiki, SPEC_DIR, 'basic'), { recursive: true });
  fs.writeFileSync(path.join(wiki, SPEC_DIR, 'basic/index.md'), '---\nt: x\n---\n# Basic\n## Error Codes\n### `_meta`\n```\n# Fake Heading\n```\n');
  fs.writeFileSync(path.join(wiki, 'terms.md'), '## Some `Thing`, v2\n');
  const hdr = `| ${HEADER.join(' | ')} |\n|${HEADER.map(() => '---').join('|')}|\n`;
  const good = (id, anchor = 'S/basic/index.md#Error Codes') => `| ${id} | ${anchor} | C | MUST | c | d | required | fixture \`x\` | |\n`;
  const w = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
  let fail = 0;
  const t = (name, files, wantSub) => {
    const errs = run(files, wiki);
    const ok = wantSub === null ? errs.length === 0 : errs.some((e) => e.includes(wantSub));
    if (!ok) { fail++; console.error(`FAIL ${name}: wanted ${wantSub ?? 'no errors'}, got ${JSON.stringify(errs)}`); }
    else console.log(`ok   ${name}`);
  };
  const row = (cells) => `| ${cells.join(' | ')} |\n`;
  const base = ['A-1', 'S/basic/index.md#Error Codes', 'C', 'MUST', '', '', 'required', 'fixture f', ''];
  const mut = (k, v) => row(base.map((x, i) => (i === k ? v : x)));

  const v1 = w('v1.md', `# T\n\n${hdr}${good('A-1')}${good('A-2', 'S/basic/index.md#error-codes')}${good('A-3', 'S/basic/index.md#_meta')}${good('A-4', 'terms.md#some-thing-v2')}${good('A-5', 'W/terms.md#Some Thing, v2; S/basic/index.md#Error Codes')}${mut(8, 'Q12').replace('A-1', 'A-7')}${mut(6, 'deprecated').replace('A-1', 'A-6').replace('fixture f', 'negative: rejects x')}`);
  t('valid doc', [v1], null);
  const v2 = w('v2.md', hdr + good('B-1'));
  t('valid two files, distinct ids', [v1, v2], null);
  t('duplicate ID across files', [v1, w('dup.md', hdr + good('A-1'))], 'duplicate ID "A-1"');
  t('duplicate ID within file', [w('d2.md', hdr + good('C-1') + good('C-1'))], 'duplicate ID');
  t('missing file', [path.join(tmp, 'nope.md')], 'file missing');
  t('empty file', [w('e.md', '  \n')], 'file is empty');
  t('no table', [w('nt.md', '# just prose\n')], 'no conformance table');
  t('header only, no rows', [w('hr.md', hdr)], 'no rows');
  t('bad header', [w('bh.md', hdr.replace('Default', 'Dflt') + good('D-1'))], 'bad header');
  t('missing separator', [w('ms.md', hdr.split('\n')[0] + '\n' + good('D-2'))], 'separator');
  t('short row', [w('sr.md', hdr + '| D-3 | S/basic/index.md#Error Codes | C |\n')], 'expected 9');
  t('long row', [w('lr.md', hdr + good('D-4').trimEnd() + ' x |\n')], 'expected 9');
  t('bad role', [w('br.md', hdr + mut(2, 'X'))], 'bad Role');
  t('bad strength', [w('bs.md', hdr + mut(3, 'must'))], 'bad Strength');
  t('bad disposition', [w('bd.md', hdr + mut(6, 'implemented'))], 'bad Disposition');
  t('blank acceptance', [w('ba.md', hdr + mut(7, ''))], 'Acceptance check is blank');
  t('bad open question', [w('bq.md', hdr + mut(8, 'Q'))], 'Open question');
  t('bad open question text', [w('bq2.md', hdr + mut(8, 'none'))], 'Open question');
  t('blank ID', [w('bi.md', hdr + mut(0, ''))], 'bad ID');
  t('anchor without heading part', [w('a1.md', hdr + mut(1, 'S/basic/index.md'))], 'not page#heading');
  t('anchor missing page', [w('a2.md', hdr + mut(1, 'S/basic/none.md#X'))], 'page not found');
  t('anchor missing heading', [w('a3.md', hdr + mut(1, 'S/basic/index.md#Nope'))], 'heading not found');
  t('anchor heading in code fence', [w('a4.md', hdr + mut(1, 'S/basic/index.md#Fake Heading'))], 'heading not found');
  t('anchor escapes wiki', [w('a5.md', hdr + mut(1, 'S/../../../../v1.md#X'))], 'page not found');
  t('anchor blank', [w('a6.md', hdr + mut(1, ''))], 'anchor is blank');
  t('malformed row not skipped among good rows', [w('mx.md', hdr + good('M-1') + '| M-2 | only |\n' + good('M-3'))], 'expected 9');
  const miss = run([v1], path.join(tmp, 'nowiki'));
  if (!miss.some((e) => e.includes('wiki root not found'))) { fail++; console.error('FAIL missing wiki root'); } else console.log('ok   missing wiki root');
  if (!run([], wiki).length) { fail++; console.error('FAIL no files'); } else console.log('ok   no files given');
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fail) { console.error(`${fail} self-test(s) failed`); process.exit(1); }
  console.log('self-test passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) selfTest();
  else {
    let wiki = defaultWikiRoot();
    const files = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--wiki-root') wiki = args[++i];
      else files.push(args[i]);
    }
    const errors = run(files, wiki);
    if (errors.length) { for (const e of errors) console.error(e); console.error(`FAIL: ${errors.length} error(s)`); process.exit(1); }
    console.log(`ok: ${files.length} file(s)`);
  }
}
