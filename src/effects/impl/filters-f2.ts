/**
 * F2 filter effects — frames, decorative borders and edge treatments (32 ids).
 *
 * Frame effects expand the canvas through `withFrame` and return the pad in
 * output pixels; edge / cut-out effects work in place and keep the size. All
 * decorative borders share `paintBorderPattern` from the ops library and only
 * differ by pattern kind, palette and which parameter carries the thickness.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    luminance,
    parseColor,
    smoothstep,
} from "../pixels.ts";
import type { EffectEnv, EffectRegistry, Insets, ParamDict } from "../types.ts";
import { paintBorderPattern, tornEdge, waveEdge, withFrame } from "../ops/index.ts";
import type { BorderKind, EdgeSides } from "../ops/index.ts";

// ---------------------------------------------------------------- param utils

function num(params: ParamDict, key: string, fallback: number): number {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(params: ParamDict, key: string, fallback: string): string {
    const value = params[key];
    return typeof value === "string" ? value : fallback;
}

function bool(params: ParamDict, key: string, fallback: boolean): boolean {
    const value = params[key];
    return typeof value === "boolean" ? value : fallback;
}

/** Rounds a pixel-unit value to whole output pixels (pads must be integers). */
function pxPad(env: EffectEnv, value: number): number {
    return Math.max(0, Math.round(env.px(value)));
}

/** Parameter keys whose values are pixel distances and need scale-correcting. */
const PIXEL_KEYS = new Set<string>([
    "border_size",
    "size",
    "border_width",
    "frame_width",
    "bottom_size",
    "padding",
    "shadow_size",
    "corner_radius",
    "tile_size",
    "grout_width",
    "panel_width",
    "lead_thickness",
    "line_thickness",
    "teeth_height",
    "teeth_width",
    "fan_spacing",
    "cell_size",
    "wire_width",
    "strand_width",
    "tube_width",
    "stripe_width",
    "mortar_thickness",
    "vein_scale",
]);

/** Copies params and scales the spatial ones to the render resolution. */
function scaleSpatial(params: ParamDict, scale: number): ParamDict {
    const out: ParamDict = {};
    for (const [key, value] of Object.entries(params)) {
        out[key] =
            typeof value === "number" && PIXEL_KEYS.has(key)
                ? value * scale
                : value;
    }
    return out;
}

// ------------------------------------------------------------ frame registry

/** Border pattern used by every expanding frame. */
const FRAME_KIND: Record<string, BorderKind> = {
    gradient_fade_border: "gradient",
    crimson_border: "crimson",
    rainbow_border: "rainbow",
    neon_glow_border: "neon",
    golden_border: "golden",
    chrome_metallic_border: "chrome",
    brick_wall_border: "brick",
    candy_cane_border: "candy",
    celtic_knot_border: "celtic",
    chain_link_border: "chain",
    circuit_board_border: "circuit",
    marble_border: "marble",
    mosaic_tile_border: "mosaic",
    rope_border: "rope",
    stained_glass_border: "stained",
    starfield_border: "starfield",
    watercolor_border: "watercolor",
    wooden_frame: "wooden",
    frost_ice_border: "frost",
    lava_molten_border: "lava",
    ornate_scroll_border: "ornate",
    art_deco_border: "artdeco",
    zigzag_border: "zigzag",
    film_strip_frame: "filmstrip",
    polaroid_frame: "polaroid",
    macos_window: "macos",
    windows11_window: "windows11",
};

/** Parameter that carries the frame thickness for each expanding id. */
const FRAME_SIZE_KEY: Record<string, string> = {
    gradient_fade_border: "border_size",
    crimson_border: "size",
    rainbow_border: "border_size",
    neon_glow_border: "border_size",
    golden_border: "size",
    chrome_metallic_border: "border_size",
    brick_wall_border: "border_size",
    candy_cane_border: "border_width",
    celtic_knot_border: "border_size",
    chain_link_border: "border_size",
    circuit_board_border: "border_size",
    marble_border: "border_size",
    mosaic_tile_border: "border_size",
    rope_border: "border_size",
    stained_glass_border: "border_size",
    starfield_border: "border_size",
    watercolor_border: "border_size",
    wooden_frame: "frame_width",
    frost_ice_border: "border_size",
    lava_molten_border: "border_size",
    ornate_scroll_border: "border_size",
    art_deco_border: "border_size",
    zigzag_border: "border_size",
    film_strip_frame: "border_size",
};

/** Default thickness per size key, matching the catalog defaults. */
const SIZE_DEFAULT: Record<string, number> = {
    border_size: 30,
    size: 10,
    border_width: 10,
    frame_width: 48,
};

/** Pad for a growing frame, always in integer output pixels. */
function padFor(id: string, params: ParamDict, env: EffectEnv): Insets {
    if (id === "border" && str(params, "type", "Outside") === "Inside") {
        return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    if (id === "polaroid_frame") {
        const side = pxPad(env, num(params, "border_size", 30));
        return {
            top: side,
            right: side,
            bottom: pxPad(env, num(params, "bottom_size", 80)),
            left: side,
        };
    }
    if (id === "macos_window" || id === "windows11_window") {
        const edge =
            pxPad(env, num(params, "padding", 20)) +
            pxPad(env, num(params, "shadow_size", 20));
        return { top: edge, right: edge, bottom: edge, left: edge };
    }
    const key = FRAME_SIZE_KEY[id] ?? "border_size";
    const size = pxPad(env, num(params, key, SIZE_DEFAULT[key] ?? 32));
    return { top: size, right: size, bottom: size, left: size };
}

/** Plain border: a stroked ring that honour the dash-style enum. */
function paintPlainBorder(
    params: ParamDict,
    env: EffectEnv,
    ctx: CanvasRenderingContext2D
): void {
    const size = Math.max(1, env.px(num(params, "size", 5)));
    const dash = str(params, "dash_style", "Solid");
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const intervals =
        dash === "Dash"
            ? [size * 3, size]
            : dash === "Dot"
              ? [size, size]
              : dash === "DashDot"
                ? [size * 3, size, size, size]
                : null;
    const half = size / 2;
    ctx.save();
    ctx.strokeStyle = str(params, "color", "#000000");
    ctx.lineWidth = size;
    if (intervals) {
        ctx.setLineDash(intervals);
    }
    ctx.strokeRect(half, half, Math.max(0, w - size), Math.max(0, h - size));
    ctx.restore();
}

/** Shared painter for every expanding frame id. */
function paintFrame(
    id: string,
    params: ParamDict,
    env: EffectEnv,
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number }
): void {
    if (id === "border") {
        paintPlainBorder(params, env, ctx);
        return;
    }
    const kind = FRAME_KIND[id];
    if (!kind) {
        return;
    }
    const scaled = scaleSpatial(params, env.scale);
    if (id === "marble_border" && typeof scaled.vein_scale === "number") {
        scaled.scale = Math.max(2, scaled.vein_scale);
    }
    paintBorderPattern(kind, scaled, ctx, rect, env.seed);
}

// ------------------------------------------------------------ frame id list

/** The 28 ids that expand the canvas. */
export const FILTER_F2_FRAME_IDS: string[] = [
    "border",
    "gradient_fade_border",
    "crimson_border",
    "rainbow_border",
    "neon_glow_border",
    "golden_border",
    "chrome_metallic_border",
    "brick_wall_border",
    "candy_cane_border",
    "celtic_knot_border",
    "chain_link_border",
    "circuit_board_border",
    "marble_border",
    "mosaic_tile_border",
    "rope_border",
    "stained_glass_border",
    "starfield_border",
    "watercolor_border",
    "wooden_frame",
    "frost_ice_border",
    "lava_molten_border",
    "ornate_scroll_border",
    "art_deco_border",
    "zigzag_border",
    "film_strip_frame",
    "polaroid_frame",
    "macos_window",
    "windows11_window",
];

// ------------------------------------------------------ in-place pixel helpers

function hash01(x: number, y: number, seed: number): number {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** Colour quantisation with ink edges and a white sticker outline. */
function cartoonStickerCutout(
    src: ImageData,
    params: ParamDict,
    env: EffectEnv
): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    const levels = Math.max(2, Math.round(num(params, "colorLevels", 8)));
    const threshold = clamp(num(params, "edgeThreshold", 32), 5, 120);
    const ink = clamp(num(params, "inkStrength", 85), 0, 100) / 100;
    const radius = Math.max(
        0,
        Math.round(env.px(num(params, "stickerBorder", 3)))
    );
    const borderStrength =
        clamp(num(params, "borderStrength", 90), 0, 100) / 100;
    const step = 255 / (levels - 1);

    const q = new Uint8ClampedArray(s.length);
    for (let i = 0; i < s.length; i += 4) {
        q[i] = Math.round(s[i] / step) * step;
        q[i + 1] = Math.round(s[i + 1] / step) * step;
        q[i + 2] = Math.round(s[i + 2] / step) * step;
        q[i + 3] = s[i + 3];
    }

    const edge = new Uint8Array(w * h);
    const scaleFactor = 255 / Math.max(1, 255 - threshold);
    for (let y = 0; y < h; y++) {
        const y0 = y > 0 ? y - 1 : 0;
        const y1 = y < h - 1 ? y + 1 : h - 1;
        for (let x = 0; x < w; x++) {
            const x0 = x > 0 ? x - 1 : 0;
            const x1 = x < w - 1 ? x + 1 : w - 1;
            const iL = (y * w + x0) * 4;
            const iR = (y * w + x1) * 4;
            const iU = (y0 * w + x) * 4;
            const iD = (y1 * w + x) * 4;
            const gx =
                Math.abs(q[iR] - q[iL]) +
                Math.abs(q[iR + 1] - q[iL + 1]) +
                Math.abs(q[iR + 2] - q[iL + 2]);
            const gy =
                Math.abs(q[iD] - q[iU]) +
                Math.abs(q[iD + 1] - q[iU + 1]) +
                Math.abs(q[iD + 2] - q[iU + 2]);
            const norm = Math.round(((gx + gy) / 6 - threshold) * scaleFactor);
            edge[y * w + x] = norm <= 0 ? 0 : Math.min(255, norm);
        }
    }

    const border =
        radius > 0 && borderStrength > 0.001
            ? dilateMax(edge, w, h, radius)
            : null;

    for (let i = 0, p = 0; i < s.length; i += 4, p++) {
        let r = q[i];
        let g = q[i + 1];
        let b = q[i + 2];
        const e = edge[p] / 255;
        if (border) {
            const borderOnly = Math.max(0, border[p] / 255 - e * 0.65);
            const mix = borderOnly * borderStrength;
            if (mix > 0.001) {
                r += (255 - r) * mix;
                g += (255 - g) * mix;
                b += (255 - b) * mix;
            }
        }
        const inkMix = e * ink;
        if (inkMix > 0.001) {
            r += (0 - r) * inkMix;
            g += (0 - g) * inkMix;
            b += (0 - b) * inkMix;
        }
        d[i] = clamp255(r);
        d[i + 1] = clamp255(g);
        d[i + 2] = clamp255(b);
    }
    return out;
}

/** Separable square max-dilation (a cheap stand-in for a circular kernel). */
function dilateMax(
    src: Uint8Array,
    w: number,
    h: number,
    radius: number
): Uint8Array {
    const r = Math.min(radius, Math.max(w, h));
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let m = 0;
            const from = Math.max(0, x - r);
            const to = Math.min(w - 1, x + r);
            for (let sx = from; sx <= to; sx++) {
                const v = src[row + sx];
                if (v > m) {
                    m = v;
                }
            }
            tmp[row + x] = m;
        }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const from = Math.max(0, y - r);
        const to = Math.min(h - 1, y + r);
        for (let x = 0; x < w; x++) {
            let m = 0;
            for (let sy = from; sy <= to; sy++) {
                const v = tmp[sy * w + x];
                if (v > m) {
                    m = v;
                }
            }
            out[y * w + x] = m;
        }
    }
    return out;
}

/** Luminance-threshold stencil tint with optional dimmed background. */
function paperStencilMask(
    src: ImageData,
    params: ParamDict,
    env: EffectEnv
): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    const threshold = clamp(num(params, "threshold", 140), 0, 255) / 255;
    const featherPx = clamp(env.px(num(params, "feather_radius", 8)), 0, 30);
    const featherRange = 0.02 + 0.13 * (featherPx / 30);
    const strength = clamp(num(params, "edge_strength", 70), 0, 100) / 100;
    const dimFactor = 1 - clamp(num(params, "background_dim", 35), 0, 100) / 100;
    const invert = bool(params, "invert_mask", false);
    const [sr, sg, sb, sa] = parseColor(str(params, "stencil_color", "#000000DC"));
    const cap = (sa / 255) * strength;
    const seed = env.seed ^ 0xcafe;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
            const jitter = (hash01(x, y, seed) * 2 - 1) * 0.003;
            let mask = smoothstep(
                threshold - featherRange + jitter,
                threshold + featherRange + jitter,
                lum
            );
            if (invert) {
                mask = 1 - mask;
            }
            const mix = clamp(mask * cap, 0, 1);
            d[i] = clamp255((s[i] * dimFactor) + (sr - s[i] * dimFactor) * mix);
            d[i + 1] = clamp255((s[i + 1] * dimFactor) + (sg - s[i + 1] * dimFactor) * mix);
            d[i + 2] = clamp255((s[i + 2] * dimFactor) + (sb - s[i + 2] * dimFactor) * mix);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Reads the four side toggles plus the curved flag. */
function edgeSides(params: ParamDict): EdgeSides {
    return {
        top: bool(params, "top", true),
        right: bool(params, "right", true),
        bottom: bool(params, "bottom", true),
        left: bool(params, "left", true),
        curved: bool(params, "curved", false),
    };
}

// ------------------------------------------------------------------ registry

const impls: EffectRegistry = {};

for (const id of FILTER_F2_FRAME_IDS) {
    impls[id] = (src, params, env) => {
        const pad = padFor(id, params, env);
        const data = withFrame(src, pad, (surface) => {
            paintFrame(id, params, env, surface.ctx, surface.rect);
        });
        return { data, pad };
    };
}

impls.torn_edge = (src, params, env) => {
    const depth = Math.max(1, Math.round(env.px(num(params, "depth", 20))));
    const range = Math.max(1, Math.round(env.px(num(params, "range", 20))));
    return tornEdge(src, depth, range, edgeSides(params), env.seed);
};

impls.wave_edge = (src, params, env) => {
    const depth = Math.max(1, Math.round(env.px(num(params, "depth", 15))));
    const range = Math.max(1, Math.round(env.px(num(params, "range", 20))));
    return waveEdge(src, depth, range, edgeSides(params), env.seed);
};

impls.cartoon_sticker_cutout = (src, params, env) =>
    cartoonStickerCutout(src, params, env);

impls.paper_stencil_mask = (src, params, env) =>
    paperStencilMask(src, params, env);

export const FILTER_F2_IMPLS: EffectRegistry = impls;
