// Bundles each serverless entry point (entry/**/*.ts, plus everything it imports, plus its libraries) into one
// self-contained JavaScript file under api/. Vercel then deploys plain JavaScript and never has to resolve our
// TypeScript files itself. Run `npm run build:api` after changing anything under src/ or entry/, and commit/ship api/.
//   node scripts/build-api.mjs          builds
//   node scripts/build-api.mjs --check  fails if api/ is out of date with the sources
import { build } from 'esbuild';
import { readdirSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

const entries = walk(join(root, 'entry'));
const outdir = check ? mkdtempSync(join(tmpdir(), 'api-check-')) : join(root, 'api');
if (!check) rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: entries,
  outdir,
  outbase: join(root, 'entry'),
  bundle: true,
  // Third-party packages stay as normal imports: Vercel installs and packages them itself.
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  // Some bundled libraries still call require(); give them one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

if (check) {
  let stale = [];
  for (const f of entries) {
    const rel = relative(join(root, 'entry'), f).replace(/\.ts$/, '.js');
    const fresh = readFileSync(join(outdir, rel), 'utf8');
    const shipped = existsSync(join(root, 'api', rel)) ? readFileSync(join(root, 'api', rel), 'utf8') : null;
    if (fresh !== shipped) stale.push(rel.split(sep).join('/'));
  }
  rmSync(outdir, { recursive: true, force: true });
  if (stale.length) { console.error('api/ is out of date for: ' + stale.join(', ') + '\nRun: npm run build:api'); process.exit(1); }
  console.log('api/ is up to date');
} else {
  console.log(`built ${entries.length} functions into api/`);
}
