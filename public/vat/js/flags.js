// Small round flags drawn as SVG (no image files, nothing fetched). Simplified on purpose: stripes, crosses and plain fields.
// A country without a drawing here gets a neutral badge with its two-letter code instead.

const h = (...c) => c.map((f, i) => `<rect width="28" height="${28 / c.length + 0.1}" y="${(28 / c.length) * i}" fill="${f}"/>`).join('');
const v = (...c) => c.map((f, i) => `<rect height="28" width="${28 / c.length + 0.1}" x="${(28 / c.length) * i}" fill="${f}"/>`).join('');
const cross = (bg, fg, inner) =>
  `<rect width="28" height="28" fill="${bg}"/><path d="M9 0v28M0 14h28" stroke="${fg}" stroke-width="5"/>${inner ? `<path d="M9 0v28M0 14h28" stroke="${inner}" stroke-width="2.4"/>` : ''}`;

const DRAW = {
  DE: h('#111', '#DD0000', '#FFCE00'),
  FR: v('#0055A4', '#fff', '#EF4135'),
  IT: v('#009246', '#fff', '#CE2B37'),
  PL: h('#fff', '#DC143C'),
  ES: `<rect width="28" height="28" fill="#C60B1E"/><rect y="7" width="28" height="14" fill="#FFC400"/>`,
  GB: `<rect width="28" height="28" fill="#012169"/><path d="M0 0 28 28M28 0 0 28" stroke="#fff" stroke-width="5"/><path d="M0 0 28 28M28 0 0 28" stroke="#C8102E" stroke-width="1.8"/><path d="M14 0v28M0 14h28" stroke="#fff" stroke-width="8"/><path d="M14 0v28M0 14h28" stroke="#C8102E" stroke-width="4.6"/>`,
  AT: h('#ED2939', '#fff', '#ED2939'),
  BE: v('#111', '#FDDA24', '#EF3340'),
  BG: h('#fff', '#00966E', '#D62612'),
  HR: h('#FF0000', '#fff', '#171796'),
  CZ: `${h('#fff', '#D7141A')}<path d="M0 0 14 14 0 28z" fill="#11457E"/>`,
  DK: cross('#C8102E', '#fff'),
  EE: h('#0072CE', '#111', '#fff'),
  FI: cross('#fff', '#003580'),
  HU: h('#CE2939', '#fff', '#477050'),
  IE: v('#169B62', '#fff', '#FF883E'),
  LV: `<rect width="28" height="28" fill="#9E3039"/><rect y="11" width="28" height="6" fill="#fff"/>`,
  LT: h('#FDB913', '#006A44', '#C1272D'),
  LU: h('#ED2939', '#fff', '#00A1DE'),
  MT: v('#fff', '#CF142B'),
  NL: h('#AE1C28', '#fff', '#21468B'),
  PT: `<rect width="28" height="28" fill="#FF0000"/><rect width="11" height="28" fill="#006600"/>`,
  RO: v('#002B7F', '#FCD116', '#CE1126'),
  SK: h('#fff', '#0B4EA2', '#EE1C25'),
  SI: h('#fff', '#005DA4', '#ED1C24'),
  SE: cross('#006AA7', '#FECC00'),
};

/** Round flag for a country code. `small` for use inside chips and tables. */
export function flag(code, small = false) {
  const c = String(code || '').toUpperCase();
  const body = DRAW[c];
  const inner = body
    ? `<svg viewBox="0 0 28 28" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`
    : `<svg viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" fill="#27407A"/><text x="14" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="sans-serif">${c.replace(/[^A-Z]/g, '').slice(0, 2)}</text></svg>`;
  return `<span class="flag${small ? ' sm' : ''}">${inner}</span>`;
}
