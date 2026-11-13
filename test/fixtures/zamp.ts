/**
 * Payloads copied from Zamp's public API docs (developer.zamp.com), so the adapter is tested
 * against the documented shapes. Replace/extend with real captured responses once a key exists.
 */

export const registrationsBody = [
  {
    state: 'KS',
    registration: { taxId: 'K100234567', startedAt: '2024-01-01', endedAt: null },
    location: { line1: '120 SW 10TH AVE', line2: null, city: 'TOPEKA', state: 'KS', zip: '66612' },
    frequencies: [{ code: 'M', startedAt: '2024-01-01', endedAt: null }],
  },
];

export const filingJan = {
  state: 'KS',
  period: { code: '2025-JAN', name: 'January 2025' },
  frequency: { code: 'M', name: 'Monthly' },
  dueOn: '2025-02-25',
  isCompleted: true,
  estimatedTaxDue: 25.25,
  artifacts: [
    {
      returnConfirmation: '7291-QXMF-8K63',
      paymentConfirmation: '7291-QXMF-8K63',
      amountPaid: 25.25,
      files: [
        { type: 'FILING_RETURN', signedUrl: 'https://files.example.invalid/ks-jan-return?sig=abc' },
        { type: 'FILING_PAYMENT', signedUrl: 'https://files.example.invalid/ks-jan-payment?sig=def' },
      ],
    },
  ],
};

export const filingFeb = {
  state: 'KS',
  period: { code: '2025-FEB', name: 'February 2025' },
  frequency: { code: 'M', name: 'Monthly' },
  dueOn: '2025-03-25',
  isCompleted: false,
  estimatedTaxDue: 31.1,
  artifacts: [],
};

export const filingsPage = (data: unknown[], nextCursor: string | null = null) => ({
  prevCursor: null,
  nextCursor,
  data,
});
