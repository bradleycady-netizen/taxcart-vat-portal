import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}

test('the shipped api/ functions are plain JavaScript and up to date with the sources', () => {
  const r = spawnSync(process.execPath, ['scripts/build-api.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('every entry point has a built function, and no TypeScript is left in api/', () => {
  const entries = walk('entry').filter((f) => f.endsWith('.ts')).map((f) => f.replace(/^entry\//, '').replace(/\.ts$/, ''));
  assert.ok(entries.length >= 8);
  for (const e of entries) assert.ok(existsSync(`api/${e}.js`), `api/${e}.js is missing`);
  assert.deepEqual(walk('api').filter((f) => !f.endsWith('.js')), [], 'api/ must hold only built .js files (a .ts file there makes Vercel resolve our sources itself)');
});

test('built functions import no local source files (only node: and installed packages)', () => {
  for (const f of walk('api')) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(!m[1]!.startsWith('.') && !m[1]!.startsWith('/'), `${f} imports ${m[1]}`);
    }
  }
});

test('vercel.json points at the built functions and uses a daily schedule the free plan accepts', () => {
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.ok(v.functions['api/**/*.js']);
  assert.equal(v.crons[0].schedule, '0 6 * * *');
});

// ------------------------------------------------------------------ hosting limits

import { readdirSync as readdirSyncL, statSync as statSyncL } from 'node:fs';
import { join as joinL } from 'node:path';

test('the number of serverless functions stays within the free Vercel plan limit of 12 (with room to spare)', () => {
  const count = (dir: string): number => readdirSyncL(dir).reduce((n, f) => (statSyncL(joinL(dir, f)).isDirectory() ? n + count(joinL(dir, f)) : n + (f.endsWith('.ts') ? 1 : 0)), 0);
  const n = count('entry');
  assert.ok(n <= 11, `${n} functions: the free plan allows 12 per deployment, and one spare is kept. Combine endpoints (see entry/staff.ts) before adding more.`);
});
