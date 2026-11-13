// Inline SVG icons (no external requests). Colours come from the surrounding text colour unless noted.
const s = (size, body, stroke = 'currentColor', w = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${w}" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  mark: s(15, '<path d="M4 7h16M4 12h16M4 17h10"/>', '#fff', 2.4),
  mail: s(15, '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>'),
  key: s(15, '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5 18 10M18.5 4.5 21 7"/>'),
  dashboard: s(16, '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  filings: s(16, '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>'),
  nexus: s(16, '<path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-8"/>'),
  registrations: s(16, '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  globe: s(14, '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>', '#fff'),
  flagUS: s(14, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/>', '#fff', 2.2),
  checkSmall: s(14, '<path d="m5 13 4 4L19 7"/>', 'currentColor', 2.4),
  logout: s(15, '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
  flag: s(16, '<path d="M4 22V4a1 1 0 0 1 1-1h14l-3 6 3 6H5"/>'),
  shield: s(16, '<path d="M12 2 4 5v6c0 5.2 3.4 9.5 8 11 4.6-1.5 8-5.8 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
  folder: s(16, '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'),
};
