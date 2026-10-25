// Line icons, 20×20 grid, stroked with currentColor by the surrounding CSS.
const svg = (body, vb = '0 0 20 20') => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  plus: svg('<path d="M10 4.5v11M4.5 10h11"/>'),
  x: svg('<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>'),
  pencil: svg('<path d="M12.6 4.4a1.6 1.6 0 0 1 2.3 0l.7.7a1.6 1.6 0 0 1 0 2.3l-8 8-3.3.7.7-3.3Z"/><path d="m11.3 5.7 3 3"/>'),
  trash: svg('<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/>'),
  play: svg('<path d="M6.5 4.8v10.4L15 10Z" fill="currentColor" stroke="none"/>'),
  refresh: svg('<path d="M15.5 9.5a5.5 5.5 0 1 1-1.6-3.9"/><path d="M15.5 3.8v3.1h-3.1"/>'),
  loop: svg('<path d="M4 9V8a2.5 2.5 0 0 1 2.5-2.5h9"/><path d="m13 3 2.5 2.5L13 8"/><path d="M16 11v1a2.5 2.5 0 0 1-2.5 2.5h-9"/><path d="M7 17l-2.5-2.5L7 12"/>'),
  toggle: svg('<rect x="5" y="5" width="10" height="10" rx="1.5"/>'),
  layers: svg('<path d="m10 3.5 6.5 3.5L10 10.5 3.5 7Z"/><path d="m3.5 10.5 6.5 3.5 6.5-3.5"/><path d="m3.5 14 6.5 3.5 6.5-3.5"/>'),
  mic: svg('<rect x="7.3" y="2.8" width="5.4" height="9.4" rx="2.7"/><path d="M4.8 9.6a5.2 5.2 0 0 0 10.4 0M10 14.8v2.6"/>'),
  micOff: svg('<path d="M12.7 8.4V5.5a2.7 2.7 0 0 0-5.2-1M7.3 7.8v1.7a2.7 2.7 0 0 0 4.4 2.1"/><path d="M4.8 9.6a5.2 5.2 0 0 0 8.6 3.9M15.2 9.6c0 .5-.1 1-.2 1.4M10 14.8v2.6M3.5 3.5l13 13"/>'),
  speaker: svg('<path d="M3.8 7.8h2.8l3.9-3.2v10.8l-3.9-3.2H3.8Z"/><path d="M13.2 7.4a3.6 3.6 0 0 1 0 5.2M15.3 5.3a6.6 6.6 0 0 1 0 9.4"/>'),
  headphones: svg('<path d="M3.8 13.2v-2.7a6.2 6.2 0 0 1 12.4 0v2.7"/><rect x="3.3" y="11.6" width="3.6" height="5.2" rx="1.4"/><rect x="13.1" y="11.6" width="3.6" height="5.2" rx="1.4"/>'),
  headphonesOff: svg('<path d="M3.8 13.2v-2.7a6.2 6.2 0 0 1 9.6-5.2M16.2 10.5v2.7"/><rect x="3.3" y="11.6" width="3.6" height="5.2" rx="1.4"/><rect x="13.1" y="11.6" width="3.6" height="5.2" rx="1.4"/><path d="M3 3l14 14"/>'),
  share: svg('<circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M7 7a4.2 4.2 0 0 0 0 6M13 7a4.2 4.2 0 0 1 0 6M4.6 4.6a7.6 7.6 0 0 0 0 10.8M15.4 4.6a7.6 7.6 0 0 1 0 10.8"/>'),
  drop: svg('<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4 15.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>', '0 0 24 24'),
};
