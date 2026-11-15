import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultDueDate, parsePeriod, periodLabel, recentEndedPeriods, validRegistration } from '../src/vat/config.ts';
import { parseCsv } from '../src/vat/csv.ts';
import { checkSalesFile, normalizeCountry, parseAmount, parseDate } from '../src/vat/validate.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const sep = parsePeriod('2026-09', 'monthly')!;
const q3 = parsePeriod('2026-Q3', 'quarterly')!;
const HEAD = 'Name,Created at,Shipping Country Code,Subtotal,Currency\n';
const check = (csv: string, scheme: 'ioss' | 'uk_vat' | 'oss' = 'ioss', period = sep, name = 'orders.csv') => checkSalesFile(name, enc(csv), { scheme, period });

test('periods: codes, labels, dates and the recent ended periods', () => {
  assert.deepEqual(parsePeriod('2026-02', 'monthly'), { code: '2026-02', label: 'Feb 2026', start: '2026-02-01', end: '2026-02-28' });
  assert.equal(parsePeriod('2028-02', 'monthly')!.end, '2028-02-29');
  assert.deepEqual(parsePeriod('2026-Q4', 'quarterly'), { code: '2026-Q4', label: 'Q4 2026', start: '2026-10-01', end: '2026-12-31' });
  assert.equal(parsePeriod('2026-Q5', 'quarterly'), null);
  assert.equal(parsePeriod('2026-13', 'monthly'), null);
  assert.equal(parsePeriod('2026-Q3', 'monthly'), null, 'a quarter code is not valid for a monthly filing');
  assert.equal(periodLabel('2026-Q3'), 'Q3 2026');
  const now = new Date('2026-10-22T03:00:00Z');
  assert.deepEqual(recentEndedPeriods(now, 'monthly', 3).map((p) => p.code), ['2026-09', '2026-08', '2026-07']);
  assert.deepEqual(recentEndedPeriods(now, 'quarterly', 2).map((p) => p.code), ['2026-Q3', '2026-Q2']);
  assert.deepEqual(recentEndedPeriods(new Date('2027-01-05T00:00:00Z'), 'monthly', 2).map((p) => p.code), ['2026-12', '2026-11'], 'crosses the year');
  assert.equal(recentEndedPeriods(new Date('2026-12-31T10:00:00Z'), 'monthly', 1)[0]!.code, '2026-11', 'the last day of a month is not yet ended');
});

test('periods: indicative due dates', () => {
  assert.equal(defaultDueDate('uk_vat', q3), '2026-11-06');
  assert.equal(defaultDueDate('ioss', sep), '2026-10-31');
  assert.equal(defaultDueDate('oss', q3), '2026-10-31');
  assert.equal(defaultDueDate('oss', parsePeriod('2026-Q4', 'quarterly')!), '2027-01-31');
  assert.equal(defaultDueDate('uk_vat', parsePeriod('2026-11', 'monthly')!), '2027-01-06');
});

test('registrations: scheme, country and frequency must fit together', () => {
  assert.equal(validRegistration('uk_vat', 'GB', 'quarterly'), null);
  assert.match(validRegistration('uk_vat', 'DE', 'quarterly')!, /United Kingdom/);
  assert.match(validRegistration('ioss', 'GB', 'monthly')!, /EU member state/);
  assert.match(validRegistration('ioss', 'PL', 'quarterly')!, /monthly/);
  assert.match(validRegistration('oss', 'FR', 'monthly')!, /quarterly/);
  assert.match(validRegistration('local_vat', 'XX', 'monthly')!, /country/);
});

test('csv reader: quotes, line breaks inside quotes, semicolons and tabs', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\r\n"line\nbreak",z'), [['a', 'b'], ['x, y', 'he said "hi"'], ['line\nbreak', 'z']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('values: amounts, dates and countries are read the way people write them', () => {
  assert.equal(parseAmount('1,250.00'), 1250);
  assert.equal(parseAmount('1.250,50'), 1250.5);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount('€ 99.90'), 99.9);
  assert.equal(parseAmount('(20.00)'), -20);
  assert.equal(parseAmount('-5'), -5);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseDate('2026-09-30 23:59:59 +1100'), '2026-09-30');
  assert.equal(parseDate('30/09/2026'), '2026-09-30');
  assert.equal(parseDate('09/30/2026'), '2026-09-30', 'month-first is recognised when the day cannot be a month');
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('yesterday'), null);
  assert.equal(normalizeCountry('de'), 'DE');
  assert.equal(normalizeCountry('Germany'), 'DE');
  assert.equal(normalizeCountry('EL'), 'GR');
  assert.equal(normalizeCountry('UK'), 'GB');
  assert.equal(normalizeCountry('ZZ'), null);
  assert.equal(normalizeCountry('Narnia'), null);
});

test('a clean export passes and is summarised by country', () => {
  const r = check(`${HEAD}#1001,2026-09-03 14:22:11 +1000,DE,100.50,EUR\n#1002,2026-09-09,FR,"1,250.00",EUR\n#1002,,,,\n#1003,2026-09-12,DE,50,EUR\n`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary!.rows, 3, 'the extra Shopify line-item row is not counted');
  assert.deepEqual(r.summary!.totals, [{ currency: 'EUR', amount: 1400.5 }]);
  assert.deepEqual(r.summary!.byCountry.map((c) => [c.code, c.rows, c.amount]), [['FR', 1, 1250], ['DE', 2, 150.5]]);
  assert.equal(r.summary!.dateFrom, '2026-09-03');
  assert.equal(r.summary!.columns.amount, 'Subtotal');
});

test('errors stop the submission and point at the rows', () => {
  const r = check(`${HEAD}#1,2026-09-03,DE,10,EUR\n#2,not a date,DE,10,EUR\n#3,2026-09-04,Narnia,10,EUR\n#4,2026-09-05,FR,lots,EUR\n#5,2026-09-06,FR,,EUR\n`);
  assert.equal(r.ok, false);
  const codes = r.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['bad_amount', 'bad_country', 'bad_date', 'blank']);
  assert.deepEqual(r.errors.find((e) => e.code === 'bad_date')!.rows, [3]);
  assert.deepEqual(r.errors.find((e) => e.code === 'bad_country')!.rows, [4]);
  assert.match(r.errors.find((e) => e.code === 'bad_country')!.message, /Narnia/);
});

test('a missing column is named, with the columns that were found', () => {
  const r = check('Order,When,Where\n1,2026-09-01,DE\n');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0]!.code, 'columns');
  assert.match(r.errors[0]!.message, /sales amount/);
  assert.match(r.errors[0]!.message, /Order, When, Where/);
});

test('rows outside the period: a few are a warning, many are an error', () => {
  const few = check(`${HEAD}${Array.from({ length: 30 }, (_, i) => `#${i},2026-09-0${(i % 9) + 1},DE,10,EUR`).join('\n')}\n#x,2026-10-01,DE,10,EUR\n`);
  assert.equal(few.ok, true);
  assert.equal(few.warnings.find((w) => w.code === 'wrong_period')!.rows![0], 32);
  const many = check(`${HEAD}#1,2026-08-03,DE,10,EUR\n#2,2026-08-09,FR,10,EUR\n#3,2026-09-12,DE,10,EUR\n`);
  assert.equal(many.ok, false);
  assert.equal(many.errors[0]!.code, 'wrong_period');
});

test('IOSS and OSS warn about non-EU destinations; UK VAT does not', () => {
  const csv = `${HEAD}#1,2026-09-03,DE,10,EUR\n#2,2026-09-04,US,10,EUR\n`;
  assert.ok(check(csv, 'ioss').warnings.some((w) => w.code === 'non_eu'));
  assert.ok(!check(csv, 'uk_vat').warnings.some((w) => w.code === 'non_eu'));
});

test('repeat orders, mixed currencies, refunds and a missing currency column are flagged as warnings', () => {
  const r = check(`${HEAD}#1,2026-09-03,DE,10,EUR\n#1,2026-09-03,DE,10,EUR\n#2,2026-09-04,FR,-5,EUR\n#3,2026-09-05,PL,10,GBP\n`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['duplicates', 'mixed_currency', 'negatives', 'template_columns']);
  assert.equal(r.summary!.totals.length, 2);
  assert.ok(check('Created at,Country,Amount\n2026-09-03,DE,10\n').warnings.some((w) => w.code === 'no_currency'));
});

test('files that cannot be used are refused with a plain message', () => {
  assert.match(check('', 'ioss').errors[0]!.message, /empty/);
  assert.match(checkSalesFile('a.xls', enc('x'), { scheme: 'ioss', period: sep }).errors[0]!.message, /\.xls/);
  assert.match(checkSalesFile('a.pdf', enc('%PDF-1'), { scheme: 'ioss', period: sep }).errors[0]!.message, /\.csv or \.xlsx/);
  assert.match(checkSalesFile('a.csv', Uint8Array.of(0x50, 0x4b, 3, 4, 0), { scheme: 'ioss', period: sep }).errors[0]!.message, /real CSV/);
  assert.match(checkSalesFile('a.xlsx', enc('just text'), { scheme: 'ioss', period: sep }).errors[0]!.message, /real Excel/);
  assert.match(checkSalesFile('a.csv', new Uint8Array(4 * 1024 * 1024 + 1), { scheme: 'ioss', period: sep }).errors[0]!.message, /4 MB/);
  assert.match(checkSalesFile('a.csv', Uint8Array.of(0x41, 0, 0x42, 0), { scheme: 'ioss', period: sep }).errors[0]!.message, /CSV/);
  assert.match(check(HEAD).errors[0]!.message, /no sales rows/);
  const broken = Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  assert.match(checkSalesFile('a.xlsx', broken, { scheme: 'ioss', period: sep }).errors[0]!.message, /could not read/);
});

test('a real Excel file (dates stored as Excel dates, a Shopify-style blank line item) is read', () => {
  const bytes = readFileSync(new URL('./fixtures/shopify-sample.xlsx', import.meta.url));
  const r = checkSalesFile('orders.xlsx', bytes, { scheme: 'ioss', period: parsePeriod('2026-10', 'monthly')! });
  assert.equal(r.fileType, 'xlsx');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.summary!.rows, 3);
  assert.equal(r.summary!.dateFrom, '2026-10-03');
  assert.deepEqual(r.summary!.totals, [{ currency: 'EUR', amount: 1330.5 }]);
});

test('a UTF-8 file with a byte-order mark and semicolons (common from European Excel) is read', () => {
  const r = checkSalesFile('o.csv', enc('﻿Created at;Shipping Country;Subtotal;Currency\n2026-09-03;Germany;"1.234,50";EUR\n'), { scheme: 'ioss', period: sep });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.summary!.totals, [{ currency: 'EUR', amount: 1234.5 }]);
});

test('the standard "sales and refunds" template layout is recognised (arrival country, VAT reporting date, item net price)', () => {
  const head = 'TYPE,TRANSACTION ID,VAT COUNTRY,PAYMENT DATE,VAT REPORTING DATE,SHIPPING DATE,ARRIVAL COUNTRY,QUANTITY,ITEM NET PRICE,ITEM VAT RATE,ORIGINAL CURRENCY\n';
  const r = check(`${head}SALE,T1,DE,2026-09-02,2026-09-03,2026-09-02,DE,1,100.50,19,EUR\nREFUND,T2,FR,2026-09-08,2026-09-09,2026-09-08,FR,1,-20,20,EUR\n`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.summary!.rows, 2);
  assert.deepEqual(r.summary!.columns, { date: 'VAT REPORTING DATE', country: 'ARRIVAL COUNTRY', amount: 'ITEM NET PRICE', currency: 'ORIGINAL CURRENCY', order: 'TRANSACTION ID' });
});

test('parseDate accepts month names, two-digit years and slashed ISO dates', () => {
  assert.equal(parseDate('15 Oct 2026'), '2026-10-15');
  assert.equal(parseDate('15-Oct-26'), '2026-10-15');
  assert.equal(parseDate('October 5, 2026'), '2026-10-05');
  assert.equal(parseDate('15/10/26'), '2026-10-15');
  assert.equal(parseDate('2026/10/15'), '2026-10-15');
  assert.equal(parseDate('2026-10-15T10:00:00Z'), '2026-10-15');
  assert.equal(parseDate('31 Feb 2026'), null);
  assert.equal(parseDate('hello'), null);
});

test('Taxcart Shopify-style template: Order name, Shipping country, Day and Net sales are all recognised (invented rows)', () => {
  const csv = [
    'Order name,Shipping country,Day,Gross sales,Discounts,Sales reversals,Net sales,Shipping charges,Return fees,Taxes,Total sales',
    '#1001,Portugal,2026-10-03,100,-10,0,90,10,0,23,123',
    '#1002,Germany,2026-10-15,50,0,0,50,5,0,10.45,65.45',
    '#1003,Spain,2026-10-20,0,0,-30,-30,0,0,0,-30',
  ].join('\n');
  const r = checkSalesFile('template.csv', new TextEncoder().encode(csv), { scheme: 'ioss', period: parsePeriod('2026-10', 'monthly')! });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.summary!.rows, 3);
  assert.equal(r.summary!.columns.date, 'Day');
  assert.equal(r.summary!.columns.amount, 'Net sales');
  assert.equal(r.summary!.columns.country, 'Shipping country');
});

test('files missing columns from the Taxcart template get a warning naming them; the full template gets none; extra columns are fine', () => {
  const full = ['Order name,Shipping country,Day,Gross sales,Discounts,Sales reversals,Net sales,Shipping charges,Return fees,Taxes,Total sales,Extra', '#1,Germany,2026-09-03,10,0,0,10,1,0,2,13,x'].join('\n');
  assert.ok(!check(full).warnings.some((w) => w.code === 'template_columns'));
  const partial = ['Order name,Shipping country,Day,Net sales', '#1,Germany,2026-09-03,10'].join('\n');
  const w = check(partial).warnings.find((x) => x.code === 'template_columns');
  assert.ok(w && w.message.includes('Gross sales') && w.message.includes('Taxes') && !w.message.includes('Net sales'));
  assert.equal(check(partial).ok, true);
});
