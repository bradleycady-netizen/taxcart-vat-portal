// Usage:  ZAMP_API_KEY=... node scripts/zamp-smoke.ts
// Optional: ZAMP_BASE_URL (default https://api.zamp.com), ZAMP_COMPANY_ID (partner keys only)
// Read-only. Prints field names and types, never your data values.
import { runSmoke } from '../src/tools/smoke.ts';

const apiKey = process.env['ZAMP_API_KEY'];
if (!apiKey) {
  console.error('Set ZAMP_API_KEY first (do not paste the key anywhere else).');
  process.exit(2);
}

const report = await runSmoke({
  apiKey,
  ...(process.env['ZAMP_BASE_URL'] ? { baseUrl: process.env['ZAMP_BASE_URL'] } : {}),
  companyId: process.env['ZAMP_COMPANY_ID'] ?? null,
});

for (const s of report.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}\n      ${s.detail}`);
console.log('\nResponse structure (field names and types only):');
console.log(JSON.stringify(report.shapes, null, 2));
console.log(report.ok ? '\nAll checks passed.' : '\nSome checks failed. Paste everything above this line (it contains no secrets or data values).');
process.exit(report.ok ? 0 : 1);
