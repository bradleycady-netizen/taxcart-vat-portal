/** Attempt limits. Each is (attempts allowed) per (window). Tune here in one place. */
export interface Rule {
  limit: number;
  windowSeconds: number;
}

export const LIMITS = {
  // Asking for a sign-in code (stops email flooding and probing)
  requestCode: {
    perEmail: { limit: 5, windowSeconds: 900 } satisfies Rule,
    perIp: { limit: 20, windowSeconds: 900 } satisfies Rule,
  },
  // Entering a code (stops guessing). 5 tries per 15 minutes against a 6-digit code leaves
  // an attacker roughly a 1-in-50,000 chance per window.
  verifyCode: {
    perEmail: { limit: 5, windowSeconds: 900 } satisfies Rule,
    perIp: { limit: 30, windowSeconds: 900 } satisfies Rule,
  },
  // Staff actions that create or change clients (stops a stolen staff session from spraying changes)
  staffWrite: {
    perUser: { limit: 40, windowSeconds: 3600 } satisfies Rule,
  },
  // VAT service: sales-file checks and submissions, replies, and the staff team's day-to-day changes
  vatUpload: { perUser: { limit: 60, windowSeconds: 3600 } satisfies Rule },
  vatWrite: { perUser: { limit: 120, windowSeconds: 3600 } satisfies Rule },
  vatStaff: { perUser: { limit: 600, windowSeconds: 3600 } satisfies Rule },
  // Document downloads per signed-in user
  download: {
    perUser: { limit: 60, windowSeconds: 600 } satisfies Rule,
  },
} as const;
