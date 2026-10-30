/**
 * Inline SVG icon set for the annotation editor.
 *
 * Every value is the inner markup of a 24x24 `viewBox`; `getIcon` wraps it in a
 * `.am-icon` `<svg>` whose visual style (18x18, `currentColor`, stroke 1.8) is
 * defined in `src/index.css`. No icon library or CDN is used.
 */
export const ICONS: Record<string, string> = {
    // ---- tools (21) ----
    select: '<path d="M5 3.5l13.5 7.6-6 1.6-2.3 5.9z"/>',
    rectangle: '<rect x="4" y="5.5" width="16" height="13" rx="1.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6.2"/>',
    line: '<line x1="5" y1="19" x2="19" y2="5"/>',
    arrow: '<path d="M5 19L18.5 5.5"/><path d="M12.5 5.5h6v6"/>',
    freehand: '<path d="M4 17.5c2.3-1 2-6.2 4.2-6.2s1.2 4.2 3.3 4.2 2.4-7.5 5-7.5"/><path d="M17 8l3-1.6"/>',
    text: '<path d="M5 6h14M12 6v12M9 18h6"/>',
    speech: '<path d="M4.5 6.5a2 2 0 012-2h11a2 2 0 012 2v7a2 2 0 01-2 2H11l-4.5 3.8v-3.8a2 2 0 01-2-2z"/>',
    step: '<circle cx="12" cy="12" r="8.2"/><path d="M10.3 9.6l1.9-1.4v7.6"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M5 17l4.8-4 3.6 3 2.6-2 3 2.5"/>',
    clone:
        '<rect x="4" y="4" width="11" height="11" rx="1.5"/><rect x="9" y="9" width="11" height="11" rx="1.5"/>',
    emoji:
        '<circle cx="12" cy="12" r="8.2"/><path d="M8.6 14.2c.8 1.1 2 1.7 3.4 1.7s2.6-.6 3.4-1.7"/><path d="M9.3 9.8h.01M14.7 9.8h.01"/>',
    cursor: '<path d="M6.5 3.2l12.3 8.2-5.5 1.4-2.4 5.7z"/>',
    highlight:
        '<path d="M10 4.5l9 9-4.5 4.5-9-9z"/><path d="M4 20h8M15 6.5l3.5 3.5"/>',
    eraser: '<path d="M7.5 18.5l-3-3 8.5-8.5 6 6-6.5 6.5z"/><path d="M4 21h16"/>',
    blur: '<path d="M12 3.2c3 3.9 6 6.9 6 10.1a6 6 0 11-12 0c0-3.2 3-6.2 6-10.1z"/>',
    pixelate:
        '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    magnify:
        '<circle cx="10.5" cy="10.5" r="6.3"/><path d="M15.2 15.2L21 21"/><path d="M7.8 10.5h5.4M10.5 7.8v5.4"/>',
    spotlight:
        '<path d="M8.5 4h7l-1 6h-5z"/><path d="M12 10v9"/><ellipse cx="12" cy="20.4" rx="3.2" ry="1.2"/>',
    crop: '<path d="M6 3v13a2 2 0 002 2h13"/><path d="M3 6h13a2 2 0 012 2v13"/>',
    cutout:
        '<circle cx="6" cy="6.5" r="2.5"/><circle cx="6" cy="17.5" r="2.5"/><path d="M8.2 8L20 18.5M8.2 16L20 6"/>',

    // ---- chrome / ui (23) ----
    file: '<path d="M13.5 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M13.5 3v5.5H19"/>',
    "panel-left": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    "panel-right": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 6.5"/>',
    undo: '<path d="M9.5 6.5L4 12l5.5 5.5"/><path d="M4 12h9.5a5 5 0 015 5v1.5"/>',
    redo: '<path d="M14.5 6.5L20 12l-5.5 5.5"/><path d="M20 12h-9.5a5 5 0 00-5 5v1.5"/>',
    trash:
        '<path d="M4 7h16M9.5 7V4.2h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10.5 11v5.5M13.5 11v5.5"/>',
    zoom: '<circle cx="10.5" cy="10.5" r="6.3"/><path d="M15.2 15.2L21 21"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h3"/>',
    save: '<path d="M5 4.5h11l3 3V19a1 1 0 01-1 1H6a1 1 0 01-1-1z"/><path d="M8.5 4.5v5h7v-5"/><path d="M8 13h8v7H8z"/>',
    "save-as":
        '<path d="M4 4.5h10l3 3v8H4z"/><path d="M7.5 4.5v5h6v-5"/><path d="M15 21l5-5M20 16h-4.5v4.5"/>',
    pin: '<path d="M9 4h6l-1 5.5 3.5 3.5H6.5L10 9.5z"/><path d="M12 13v7"/>',
    bookmark:
        '<path d="M6.5 4.5h11a1 1 0 011 1V20l-6.5-4.2L5.5 20V5.5a1 1 0 011-1z"/>',
    print:
        '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7.5" rx="1.5"/><rect x="7" y="16.5" width="10" height="4" rx="1"/>',
    upload:
        '<path d="M12 16.5V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16.5v2.5A1.5 1.5 0 005.5 20.5h13a1.5 1.5 0 001.5-1.5v-2.5"/>',
    "chevron-down": '<path d="M6 9.5l6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="6.3"/><path d="M15.6 15.6L21 21"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folder: '<path d="M3.5 7.5a2 2 0 012-2h3.6l2 2h7.4a2 2 0 012 2v8a2 2 0 01-2 2H5.5a2 2 0 01-2-2z"/>',
    history:
        '<path d="M3.5 12a8.5 8.5 0 108.5-8.5c-3.1 0-5.6 1.7-6.9 4"/><path d="M3 3.5V8h4.5"/><path d="M12 7.5V12l3.2 2"/>',
    exit: '<path d="M14 4h4.5A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5H14"/><path d="M3.5 12H14"/><path d="M9.5 8l4 4-4 4"/>',
    dot: '<circle cx="12" cy="12" r="3.2"/>',
    minus: '<path d="M5 12h14"/>',

    // ---- image effects (37, `crop` shared with tools) ----
    maximize:
        '<path d="M4 9.5V5.5A1.5 1.5 0 015.5 4h4"/><path d="M14.5 4h4A1.5 1.5 0 0120 5.5v4"/><path d="M20 14.5v4a1.5 1.5 0 01-1.5 1.5h-4"/><path d="M9.5 20h-4A1.5 1.5 0 014 18.5v-4"/>',
    "rotate-cw": '<path d="M20 4.5V10h-5.5"/><path d="M19.4 10a8 8 0 10-2.6 7.6"/>',
    "flip-horizontal": '<path d="M12 3v18"/><path d="M8.5 8L3.5 12l5 4z"/><path d="M15.5 8l5 4-5 4z"/>',
    "flip-vertical": '<path d="M3 12h18"/><path d="M8 8.5l4-5 4 5z"/><path d="M8 15.5l4 5 4-5z"/>',
    scan: '<path d="M4 9V5.5A1.5 1.5 0 015.5 4H9"/><path d="M15 4h3.5A1.5 1.5 0 0120 5.5V9"/><path d="M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15"/><path d="M9 20H5.5A1.5 1.5 0 014 18.5V15"/><path d="M4 12h16"/>',
    square: '<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
    contrast: '<circle cx="12" cy="12" r="8.3"/><path d="M12 3.7v16.6"/><path d="M12 3.7a8.3 8.3 0 010 16.6"/>',
    droplet: '<path d="M12 3.2c3 3.9 6 6.9 6 10.1a6 6 0 11-12 0c0-3.2 3-6.2 6-10.1z"/>',
    palette:
        '<path d="M12 3.2a8.8 8.8 0 000 17.6c1.5 0 2.2-1 1.7-2.3-.5-1.3.4-2.4 1.8-2.4H17a4 4 0 004-4c0-4.9-4-8.9-9-8.9z"/><path d="M8 9.5h.01M12 7.5h.01M15.8 9.8h.01M8.5 13.5h.01"/>',
    sliders:
        '<path d="M3.5 7h4M12 7h8.5M3.5 12h8M16 12h4.5M3.5 17h2.5M10 17h10.5"/><circle cx="9.8" cy="7" r="2.2"/><circle cx="14" cy="12" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
    "circle-slash": '<circle cx="12" cy="12" r="8.3"/><path d="M6.2 17.8L17.8 6.2"/>',
    "refresh-ccw": '<path d="M4 4.5V10h5.5"/><path d="M4.6 10a8 8 0 112.6 7.6"/>',
    coffee: '<path d="M4 8.5h12V14a4 4 0 01-4 4H8a4 4 0 01-4-4z"/><path d="M16 9.5h1.8a2.3 2.3 0 010 4.6H16"/><path d="M3.5 21h14"/>',
    "circle-dot": '<circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="2.6"/>',
    wand: '<path d="M5 19.5L15.5 9"/><path d="M14.5 3.5l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3L10 8l3.3-1.2z"/><path d="M4 5.5h.01M19.5 16h.01"/>',
    "paint-bucket":
        '<path d="M11 3.5l8 8-6.6 6.6a1.8 1.8 0 01-2.5 0L3.5 11.5z"/><path d="M19.5 15.2c1 1.3 1.6 2.1 1.6 2.9a1.6 1.6 0 11-3.2 0c0-.8.6-1.6 1.6-2.9z"/>',
    layers: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
    cloud: '<path d="M7 18.5a4.2 4.2 0 01-.6-8.4 6 6 0 0111.6 1.8A3.6 3.6 0 0117.5 18.5z"/>',
    grid: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>',
    focus: '<path d="M4 9V5.5A1.5 1.5 0 015.5 4H9"/><path d="M15 4h3.5A1.5 1.5 0 0120 5.5V9"/><path d="M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15"/><path d="M9 20H5.5A1.5 1.5 0 014 18.5V15"/><circle cx="12" cy="12" r="3"/>',
    mountain: '<path d="M3 18.5l5-7 3.8 4.8 2.7-3.5 6.5 5.7z"/><circle cx="8.5" cy="7" r="1.6"/>',
    frame: '<path d="M9 3.5H5A1.5 1.5 0 003.5 5v4"/><path d="M15 3.5h4A1.5 1.5 0 0120.5 5v4"/><path d="M20.5 15v4a1.5 1.5 0 01-1.5 1.5h-4"/><path d="M9 20.5H5A1.5 1.5 0 013.5 19v-4"/>',
    brush: '<path d="M14 4.5l5.5 5.5-8.5 8.5H5.5v-5.5z"/><path d="M12 6.5l5.5 5.5"/>',
    circle: '<circle cx="12" cy="12" r="8.3"/>',
    sparkles:
        '<path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5l-1.7-4.3L5 9.5l4.3-1.7z"/><path d="M17.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    grain: '<path d="M6 6.5h.01M12 6.5h.01M18 6.5h.01M6 12h.01M12 12h.01M18 12h.01M6 17.5h.01M12 17.5h.01M18 17.5h.01"/>',
    wind: '<path d="M3 8.5h10.5a3 3 0 10-3-3"/><path d="M3 13h7a3 3 0 110 6"/><path d="M3 17.5h5"/>',
    pencil: '<path d="M4 20h4l10.5-10.5-4-4L4 16z"/><path d="M13.5 5.5l4 4"/>',
    aperture:
        '<circle cx="12" cy="12" r="8.3"/><path d="M12 3.7l4.1 7.1M20.3 12h-8.2M16.2 19.2l-4.1-7.1M7.8 19.2l4.1-7.1M3.7 12h8.2M7.8 4.8l4.1 7.1"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M9 11.5h12"/>',
    blend: '<circle cx="9.5" cy="12" r="5.5"/><circle cx="14.5" cy="12" r="5.5"/>',
    "mouse-pointer": '<path d="M6.5 3.2l12.3 8.2-5.5 1.4-2.4 5.7z"/><path d="M12.2 15.4l3 5.4"/>',
    snowflake:
        '<path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9"/><path d="M9.5 4.5L12 6.5l2.5-2M9.5 19.5L12 17.5l2.5 2"/>',
    party: '<path d="M4 20l6.5-15 6 6z"/><path d="M15.5 4.5h.01M19 7h.01M18.5 12.5h.01M14.5 9.5h.01"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/>',
};

/** Complete `<svg>` markup for an icon id; unknown ids fall back to `dot`. */
export function getIcon(id: string): string {
    const inner = ICONS[id] ?? ICONS.dot;
    return `<svg class="am-icon" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

/** Convenience factory for icon-only buttons. */
export function iconButton(
    id: string,
    title: string,
    className?: string
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className ? `am-btn am-icon-btn ${className}` : "am-btn am-icon-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.dataset.icon = id;
    btn.innerHTML = getIcon(id);
    return btn;
}
