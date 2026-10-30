/**
 * Style-template storage and preview markup.
 *
 * Four built-in presets plus user-saved presets persisted in `localStorage`.
 * This module never touches the DOM: previews are returned as HTML strings so
 * the same code can be unit-tested in Node and rendered by the panel.
 */
import {
    BORDER_STYLES,
    TOOL_ORDER,
    createOptions,
} from "../types.ts";
import type {
    BorderStyle,
    ShadowState,
    StyleTemplate,
    ToolId,
    ToolOptions,
} from "../types.ts";

export const TEMPLATES_KEY = "anno-mark.style-templates.v1";

type OptionsPatch = Partial<Omit<ToolOptions, "shadow">> & {
    shadow?: Partial<ShadowState>;
};

/** Complete options cloned from `createOptions()` with a fresh shadow object. */
function templateOptions(patch: OptionsPatch): ToolOptions {
    const base = createOptions();
    return {
        ...base,
        ...patch,
        shadow: { ...base.shadow, ...(patch.shadow ?? {}) },
    };
}

export const BUILTIN_TEMPLATES: StyleTemplate[] = [
    {
        id: "builtin-red-box",
        name: "红色标注框",
        tool: "rectangle",
        builtin: true,
        opts: templateOptions({
            stroke: "#F03E3E",
            width: 4,
            borderStyle: "solid",
            fill: "transparent",
            corner: 0,
        }),
    },
    {
        id: "builtin-yellow-text",
        name: "黄字黑影",
        tool: "text",
        builtin: true,
        opts: templateOptions({
            textColor: "#FFD60A",
            fontSize: 28,
            bold: true,
            shadow: {
                enabled: true,
                color: "#000000",
                blur: 12,
                opacity: 0.55,
                x: 2,
                y: 2,
            },
        }),
    },
    {
        id: "builtin-blue-highlight",
        name: "蓝色高亮",
        tool: "rectangle",
        builtin: true,
        opts: templateOptions({
            stroke: "#3E83F2",
            width: 4,
            fill: "rgba(62,131,242,0.22)",
            borderStyle: "solid",
        }),
    },
    {
        id: "builtin-gray-dash",
        name: "虚线灰框",
        tool: "rectangle",
        builtin: true,
        opts: templateOptions({
            stroke: "#8B8D98",
            width: 2,
            borderStyle: "dash",
            fill: "transparent",
        }),
    },
];

/** Deep copy; `ToolOptions` only nests `shadow`, which is copied explicitly. */
function cloneOptions(opts: ToolOptions): ToolOptions {
    return {
        ...opts,
        shadow: { ...opts.shadow },
    };
}

export function isStyleTemplate(value: unknown): value is StyleTemplate {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Partial<StyleTemplate> & {
        opts?: unknown;
        builtin?: unknown;
    };

    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
        return false;
    }
    if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
        return false;
    }
    if (
        typeof candidate.tool !== "string" ||
        !TOOL_ORDER.includes(candidate.tool as ToolId)
    ) {
        return false;
    }
    // Built-in entries never belong in the user-saved bucket.
    if (candidate.builtin === true) {
        return false;
    }

    const opts = candidate.opts;
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
        return false;
    }
    const record = opts as unknown as Record<string, unknown>;
    if (typeof record.stroke !== "string") {
        return false;
    }
    if (typeof record.width !== "number" || !Number.isFinite(record.width)) {
        return false;
    }
    if (
        typeof record.borderStyle !== "string" ||
        !BORDER_STYLES.includes(record.borderStyle as BorderStyle)
    ) {
        return false;
    }
    const shadow = record.shadow;
    if (shadow === null || typeof shadow !== "object" || Array.isArray(shadow)) {
        return false;
    }
    return true;
}

/** Read user-saved templates; malformed entries and duplicates are dropped. */
export function loadTemplates(): StyleTemplate[] {
    try {
        const store = globalThis.localStorage;
        const raw = store === undefined ? null : store.getItem(TEMPLATES_KEY);
        if (raw === null || raw === "") {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const list: StyleTemplate[] = [];
        const seen = new Set<string>();
        for (const item of parsed) {
            if (!isStyleTemplate(item)) {
                continue;
            }
            if (seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);
            list.push({
                id: item.id,
                name: item.name,
                tool: item.tool,
                opts: cloneOptions(item.opts),
                builtin: false,
            });
        }
        return list;
    } catch {
        return [];
    }
}

/** Persist only custom templates; built-ins always come from the bundle. */
export function saveTemplates(list: StyleTemplate[]): void {
    try {
        const custom = list
            .filter((template) => template.builtin !== true)
            .map((template) => ({
                id: template.id,
                name: template.name,
                tool: template.tool,
                opts: cloneOptions(template.opts),
            }));
        const store = globalThis.localStorage;
        if (store === undefined) {
            return;
        }
        store.setItem(TEMPLATES_KEY, JSON.stringify(custom));
    } catch {
        // Storage can be unavailable or full; saving is best-effort.
    }
}

let templateSequence = 0;

/** Build a new custom template with a collision-free id and cloned options. */
export function createTemplate(
    name: string,
    tool: ToolId,
    opts: ToolOptions,
    existing: readonly StyleTemplate[] = []
): StyleTemplate {
    const trimmed = typeof name === "string" ? name.trim() : "";
    const existingIds = new Set(existing.map((template) => template.id));

    let id = "";
    do {
        id = `tpl-${Date.now().toString(36)}${templateSequence++}`;
    } while (existingIds.has(id));

    return {
        id,
        name: trimmed === "" ? "未命名样式" : trimmed,
        tool,
        opts: cloneOptions(opts),
        builtin: false,
    };
}

/** Remove one custom template and return the remaining custom list. */
export function deleteTemplate(id: string): StyleTemplate[] {
    const rest = loadTemplates().filter((template) => template.id !== id);
    saveTemplates(rest);
    return rest;
}

// ---------------------------------------------------------------------------
// Preview markup
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGBA_COLOR =
    /^rgba?\(\s*[0-9.]+%?\s*,\s*[0-9.]+%?\s*,\s*[0-9.]+%?\s*(?:,\s*[0-9.]+%?\s*)?\)$/i;
const FONT_FAMILY = /^[a-z0-9 _-]+$/i;

function isSafeColor(value: string): boolean {
    return (
        HEX_COLOR.test(value) ||
        RGBA_COLOR.test(value) ||
        value.toLowerCase() === "transparent"
    );
}

/** Only hex / rgb(a) / transparent reach the style attribute. */
function safeColor(value: unknown, fallback = "transparent"): string {
    if (typeof value !== "string") {
        return fallback;
    }
    const trimmed = value.trim();
    return isSafeColor(trimmed) ? trimmed : fallback;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function clampNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number
): number {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

function safeFontFamily(value: unknown): string {
    if (typeof value !== "string") {
        return "'Segoe UI',sans-serif";
    }
    const family = value.trim();
    return FONT_FAMILY.test(family)
        ? `'${family}',sans-serif`
        : "'Segoe UI',sans-serif";
}

/** Hex colours become `rgba()` so the shadow opacity is honoured. */
function shadowColor(color: unknown, opacity: unknown): string {
    const value = safeColor(color, "#000000");
    if (value.toLowerCase() === "transparent") {
        return "transparent";
    }
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    if (match === null) {
        return value;
    }
    const digits = match[1];
    const full =
        digits.length === 3
            ? digits
                  .split("")
                  .map((char) => char + char)
                  .join("")
            : digits;
    const red = parseInt(full.slice(0, 2), 16);
    const green = parseInt(full.slice(2, 4), 16);
    const blue = parseInt(full.slice(4, 6), 16);
    const alpha = clampNumber(opacity, 1, 0, 1);
    return `rgba(${red},${green},${blue},${String(Number(alpha.toFixed(2)))})`;
}

function shadowCss(shadow: ShadowState): string {
    if (shadow.enabled !== true) {
        return "none";
    }
    const x = clampNumber(shadow.x, 0, -100, 100);
    const y = clampNumber(shadow.y, 0, -100, 100);
    const blur = clampNumber(shadow.blur, 0, 0, 200);
    return `${x}px ${y}px ${blur}px ${shadowColor(shadow.color, shadow.opacity)}`;
}

/** Border-style keyword used by the preview boxes. */
export function borderStyleCss(style: BorderStyle | string): string {
    if (style === "dash" || style === "dashed") {
        return "dashed";
    }
    if (style === "dot" || style === "dotted") {
        return "dotted";
    }
    if (style === "dashdot") {
        return "dashed";
    }
    return "solid";
}

function dashArray(style: BorderStyle | string): string {
    if (style === "dash" || style === "dashed") {
        return "7 5";
    }
    if (style === "dot" || style === "dotted") {
        return "2 4";
    }
    if (style === "dashdot") {
        return "9 4 2 4";
    }
    return "";
}

function textPreview(opts: ToolOptions): string {
    const color = safeColor(opts.textColor);
    const family = safeFontFamily(opts.fontFamily);
    const weight = opts.bold === false ? 400 : 700;
    const fontStyle = opts.italic === true ? "italic" : "normal";
    const shadow = shadowCss(opts.shadow);
    return (
        `<span class="am-tpl-aa" style="color:${escapeHtml(color)};` +
        `font-family:${escapeHtml(family)};font-weight:${weight};` +
        `font-style:${fontStyle};text-shadow:${escapeHtml(shadow)}">Aa</span>`
    );
}

function linePreview(tool: ToolId, opts: ToolOptions): string {
    const stroke = safeColor(opts.stroke);
    const width = clampNumber(opts.width, 2, 1, 6);
    const dash = dashArray(opts.borderStyle);
    const dashAttr = dash === "" ? "" : ` stroke-dasharray="${dash}"`;
    const common =
        `stroke="${escapeHtml(stroke)}" stroke-width="${width}" ` +
        `stroke-linecap="round" stroke-linejoin="round"`;

    let shape: string;
    if (tool === "arrow") {
        shape =
            `<line x1="10" y1="19" x2="82" y2="19" ${common}${dashAttr}/>` +
            `<polygon points="90,19 78,13.5 78,24.5" ` +
            `fill="${escapeHtml(stroke)}"/>`;
    } else if (tool === "freehand") {
        shape =
            `<polyline points="10,26 24,11 40,24 56,12 72,23 90,15" ` +
            `fill="none" ${common}${dashAttr}/>`;
    } else {
        shape = `<line x1="10" y1="19" x2="90" y2="19" ${common}${dashAttr}/>`;
    }

    return (
        `<svg viewBox="0 0 100 38" class="am-tpl-line" ` +
        `preserveAspectRatio="none" aria-hidden="true">${shape}</svg>`
    );
}

function stepPreview(opts: ToolOptions): string {
    const stroke = safeColor(opts.stroke);
    const fill = safeColor(opts.fill);
    const circleFill = fill.toLowerCase() === "transparent" ? stroke : fill;
    const color = safeColor(opts.textColor);
    const family = safeFontFamily(opts.fontFamily);
    return (
        `<span class="am-tpl-step" style="background:${escapeHtml(circleFill)};` +
        `color:${escapeHtml(color)};font-family:${escapeHtml(family)};` +
        `box-shadow:${escapeHtml(shadowCss(opts.shadow))}">1</span>`
    );
}

function boxPreview(tool: ToolId, opts: ToolOptions): string {
    const stroke = safeColor(opts.stroke);
    const fill = safeColor(opts.fill);
    const width = clampNumber(opts.width, 2, 1, 6);
    const corner = clampNumber(opts.corner, 0, 0, 14);
    const isEllipse = tool === "ellipse";
    const radius = isEllipse
        ? "50%"
        : `${tool === "speech" ? Math.max(12, corner) : corner}px`;
    const className = isEllipse ? "am-tpl-box is-ellipse" : "am-tpl-box";
    return (
        `<span class="${className}" style="border:${width}px ` +
        `${borderStyleCss(opts.borderStyle)} ${escapeHtml(stroke)};` +
        `border-radius:${radius};background:${escapeHtml(fill)};` +
        `box-shadow:${escapeHtml(shadowCss(opts.shadow))}"></span>`
    );
}

/** Self-contained swatch markup for one template (no DOM APIs). */
export function templatePreviewHTML(template: StyleTemplate): string {
    const opts = template.opts;
    if (template.tool === "text") {
        return textPreview(opts);
    }
    if (
        template.tool === "line" ||
        template.tool === "arrow" ||
        template.tool === "freehand"
    ) {
        return linePreview(template.tool, opts);
    }
    if (template.tool === "step") {
        return stepPreview(opts);
    }
    return boxPreview(template.tool, opts);
}
