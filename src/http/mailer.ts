import type { Env } from '../providers/registry.ts';

/**
 * Sends the welcome email to a new client. Off unless INVITE_EMAILS_ENABLED=true AND RESEND_API_KEY is set,
 * so deploying this code before the sending domain is verified changes nothing.
 * The key is read from the environment only; never put it in code, notes or chat.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** True if the provider accepted the message. Never throws. */
  send(mail: Mail): Promise<boolean>;
}

export const DEFAULT_FROM = 'Taxcart <portal@mail.taxcart.com.au>';
export const DEFAULT_REPLY_TO = 'consulting@taxcart.com.au';

export class ResendMailer implements Mailer {
  private apiKey: string;
  private from: string;
  private replyTo: string;
  private fetchImpl: typeof fetch;
  constructor(apiKey: string, from: string, replyTo: string, fetchImpl: typeof fetch) {
    this.apiKey = apiKey;
    this.from = from;
    this.replyTo = replyTo;
    this.fetchImpl = fetchImpl;
  }
  async send(mail: Mail): Promise<boolean> {
    try {
      const res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [mail.to], reply_to: this.replyTo, subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function buildMailer(env: Env, fetchImpl: typeof fetch): Mailer | undefined {
  if (env['INVITE_EMAILS_ENABLED'] !== 'true') return undefined;
  const key = env['RESEND_API_KEY'];
  if (!key) return undefined;
  return new ResendMailer(key, env['INVITE_FROM'] || DEFAULT_FROM, env['INVITE_REPLY_TO'] || DEFAULT_REPLY_TO, fetchImpl);
}

/** The portal address clients are sent to: PORTAL_URL if set, else the first allowed origin + /vat/. */
export function portalUrl(env: Env, firstOrigin: string): string {
  const set = env['PORTAL_URL'];
  if (set) { try { return new URL(set).toString(); } catch { /* fall through */ } }
  return `${firstOrigin}/vat/`;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function welcomeEmail(p: { to: string; clientName: string; portalUrl: string; contact: string }): Mail {
  const subject = 'Welcome to the Taxcart VAT portal';
  const text = [
    `Welcome to Taxcart.`,
    ``,
    `Your VAT portal for ${p.clientName} is ready. This is where you send us your sales files and follow each VAT return from start to finish.`,
    ``,
    `To get started:`,
    `1. Open ${p.portalUrl}`,
    `2. Enter this email address (${p.to}) and ask for a sign-in code.`,
    `3. We email you a 6-digit code. Type it in to sign in. There is no password to remember.`,
    `4. Choose your filing and period, add your sales file (CSV or Excel), check it, and send it to us.`,
    ``,
    `Please use this exact email address to sign in. A different address will not see your company.`,
    ``,
    `Questions? Reply to this email or write to ${p.contact}.`,
    ``,
    `The Taxcart team`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#EAF1FE;font-family:Arial,Helvetica,sans-serif;color:#0B1F4D"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px"><h1 style="font-size:20px;margin:0 0 12px">Welcome to Taxcart</h1><p style="line-height:1.5">Your VAT portal for <strong>${escHtml(p.clientName)}</strong> is ready. This is where you send us your sales files and follow each VAT return from start to finish.</p><ol style="line-height:1.6;padding-left:20px"><li>Open the portal below.</li><li>Enter this email address (<strong>${escHtml(p.to)}</strong>) and ask for a sign-in code.</li><li>We email you a 6-digit code. Type it in. There is no password to remember.</li><li>Choose your filing and period, add your sales file (CSV or Excel), check it, and send it to us.</li></ol><p style="margin:22px 0"><a href="${escHtml(p.portalUrl)}" style="background:#0A66F5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">Open your portal</a></p><p style="line-height:1.5;font-size:14px">Please use this exact email address to sign in. A different address will not see your company.</p><p style="line-height:1.5;font-size:14px">Questions? Reply to this email or write to <a href="mailto:${escHtml(p.contact)}">${escHtml(p.contact)}</a>.</p><p style="font-size:14px;margin-bottom:0">The Taxcart team</p></div></body></html>`;
  return { to: p.to, subject, text, html };
}

/** A short internal alert to the shared Taxcart inbox. Never include buyer details or file contents. */
export function staffAlertEmail(p: { to: string; subject: string; lines: string[]; portalUrl: string }): Mail {
  const text = [...p.lines, '', `Open the portal: ${p.portalUrl}`].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#0B1F4D"><div style="max-width:560px;margin:0 auto">${p.lines.map((l) => `<p style="line-height:1.5;margin:0 0 10px">${escHtml(l)}</p>`).join('')}<p style="margin-top:18px"><a href="${escHtml(p.portalUrl)}">Open the portal</a></p></div></body></html>`;
  return { to: p.to, subject: p.subject, text, html };
}
