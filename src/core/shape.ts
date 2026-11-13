import { ProviderError } from './errors.ts';

/**
 * Small, dependency-free response validators. Provider responses are untrusted input: every
 * field we rely on is checked, and anything unexpected becomes a 'bad_response' ProviderError
 * instead of a crash or silently wrong data deeper in the app.
 */
export class Shape {
  readonly provider: string;

  constructor(provider: string) {
    this.provider = provider;
  }

  fail(where: string, problem: string): never {
    throw new ProviderError('bad_response', this.provider, `Unexpected response at ${where}: ${problem}`);
  }

  record(v: unknown, where: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail(where, 'expected an object');
    return v as Record<string, unknown>;
  }

  array(v: unknown, where: string): unknown[] {
    if (!Array.isArray(v)) this.fail(where, 'expected an array');
    return v as unknown[];
  }

  string(o: Record<string, unknown>, key: string, where: string): string {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0) this.fail(`${where}.${key}`, 'expected a non-empty string');
    return v as string;
  }

  optString(o: Record<string, unknown>, key: string, where: string): string | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') this.fail(`${where}.${key}`, 'expected a string or null');
    return v as string;
  }

  boolean(o: Record<string, unknown>, key: string, where: string): boolean {
    const v = o[key];
    if (typeof v !== 'boolean') this.fail(`${where}.${key}`, 'expected a boolean');
    return v as boolean;
  }

  optNumber(o: Record<string, unknown>, key: string, where: string): number | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(`${where}.${key}`, 'expected a finite number or null');
    return v as number;
  }

  /** An ISO calendar date (YYYY-MM-DD). A full timestamp is accepted and trimmed to its date. */
  date(o: Record<string, unknown>, key: string, where: string): string {
    const v = this.string(o, key, where);
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (!m) this.fail(`${where}.${key}`, 'expected an ISO date');
    return (m as RegExpExecArray)[1] as string;
  }

  optDate(o: Record<string, unknown>, key: string, where: string): string | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    return this.date(o, key, where);
  }
}
