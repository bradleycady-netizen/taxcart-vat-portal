import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeShape, runSmoke } from '../src/tools/smoke.ts';
import { fakeFetch, json } from './helpers.ts';
import { filingJan, filingsPage, registrationsBody } from './fixtures/zamp.ts';

const live = () =>
  fakeFetch((url) => {
    if (url.pathname === '/companies') return json([{ id: 'c1', legalName: 'Acme Inc.' }]);
    if (url.pathname === '/registrations') return json(registrationsBody);
    return json(filingsPage([filingJan]));
  });

test('smoke run passes against documented shapes', async () => {
  const report = await runSmoke({ apiKey: 'k', fetchImpl: live().fetch });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.equal(report.steps.length, 4);
});

test('the shape dump contains field names and types but none of the data', async () => {
  const report = await runSmoke({ apiKey: 'k', fetchImpl: live().fetch });
  const dump = JSON.stringify(report.shapes);
  assert.ok(dump.includes('taxId') && dump.includes('estimatedTaxDue') && dump.includes('signedUrl'));
  for (const secret of ['K100234567', '7291-QXMF-8K63', 'files.example.invalid', 'TOPEKA']) {
    assert.ok(!dump.includes(secret), `shape dump leaked ${secret}`);
  }
});

test('a rejected key is reported as a failed step, not a crash', async () => {
  const { fetch } = fakeFetch(() => json({ message: 'no' }, 401));
  const report = await runSmoke({ apiKey: 'bad', fetchImpl: fetch });
  assert.equal(report.ok, false);
  assert.match(report.steps[0]!.detail, /^auth:/);
});

test('a response that differs from the docs is pinpointed by field path', async () => {
  const drifted = { ...filingJan, isCompleted: 'yes' };
  const { fetch } = fakeFetch((url) =>
    url.pathname === '/registrations' || url.pathname === '/companies' ? json(registrationsBody) : json(filingsPage([drifted])),
  );
  const report = await runSmoke({ apiKey: 'k', fetchImpl: fetch });
  const filings = report.steps.find((s) => s.name.startsWith('Filings'))!;
  assert.equal(filings.ok, false);
  assert.match(filings.detail, /filings\.data\[0\]\.isCompleted/);
});

test('describeShape reduces values to types', () => {
  assert.deepEqual(describeShape({ a: 1, b: ['x'], c: null, d: { e: true } }), { a: 'number', b: ['string'], c: 'null', d: { e: 'boolean' } });
});
