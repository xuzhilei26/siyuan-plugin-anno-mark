/**
 * Native ShareX "Drawings" effects (tier B). The remaining drawing ids are
 * tier C and are delegated to editor tools, so they never live here.
 *
 * Every effect keeps the source dimensions, never mutates the input buffer and
 * renders procedurally with a per-instance seed. Particle-like overlays are
 * painted into a transparent layer so the `background` flag can place them
 * beneath (or above) the source image. The text watermark uses a real DOM
 * canvas for glyphs and degrades to a translucent rounded label in Node.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    makeImageData,
    parseColor,
    smoothstep,
} from "../pixels.ts";
import { deriveSeed, mulberry32 } from "../rand.ts";
import type { EffectImpl, EffectRegistry, ParamDict } from "../types.ts";

type RGBA = [number, number, number, number];

// ---------------------------------------------------------------- param utils

function num(params: ParamDict, key: string, fallback: number): number {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOf(params: ParamDict, key: string, fallback: boolean): boolean {
    const value = params[key];
    return typeof value === "boolean" ? value : fallback;
}

function strOf(params: ParamDict, key: string, fallback: string): string {
    const value = params[key];
    return typeof value === "string" ? value : fallback;
}

/** Scales a pixel-unit value and clamps it to a sane positive float. */
function pxSize(env: { px(value: number): number }, value: number, min = 0.5): number {
    const scaled = env.px(value);
    return Number.isFinite(scaled) ? Math.max(min, scaled) : min;
}

/** Integer variant of {@link pxSize}. */
function pxInt(env: { px(value: number): number }, value: number, min = 1): number {
    return Math.max(min, Math.round(pxSize(env, value, min)));
}

/** Inclusive-free random integer in [min,max) mirroring Random.Next. */
function pickInt(rand: () => number, min: number, max: number): number {
    let lo = min;
    let hi = max;
    if (lo > hi) {
        const swap = lo;
        lo = hi;
        hi = swap;
    }
    if (hi - lo <= 1) {
        return lo;
    }
    return lo + Math.floor(rand() * (hi - lo));
}

// -------------------------------------------------------------- draw helpers

/** Source-over of a straight-alpha colour onto one RGBA pixel. */
function overPixel(data: Uint8ClampedArray, index: number, color: RGBA, alpha: number): void {
    const sa = clamp(alpha, 0, 1) * (clamp(color[3], 0, 255) / 255);
    if (sa <= 0) {
        return;
    }
    const da = data[index + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
        return;
    }
    const keep = da * (1 - sa);
    data[index] = clamp255((color[0] * sa + data[index] * keep) / oa);
    data[index + 1] = clamp255((color[1] * sa + data[index + 1] * keep) / oa);
    data[index + 2] = clamp255((color[2] * sa + data[index + 2] * keep) / oa);
    data[index + 3] = clamp255(oa * 255);
}

/** Composites `top` over `base` (both same size) into a new buffer. */
function compositeTop(base: ImageData, top: ImageData): ImageData {
    const out = makeImageData(base.width, base.height);
    const b = base.data;
    const t = top.data;
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        const ta = t[i + 3] / 255;
        const ba = b[i + 3] / 255;
        const oa = ta + ba * (1 - ta);
        if (oa <= 0) {
            continue;
        }
        const keep = ba * (1 - ta);
        d[i] = clamp255((t[i] * ta + b[i] * keep) / oa);
        d[i + 1] = clamp255((t[i + 1] * ta + b[i + 1] * keep) / oa);
        d[i + 2] = clamp255((t[i + 2] * ta + b[i + 2] * keep) / oa);
        d[i + 3] = clamp255(oa * 255);
    }
    return out;
}

/** Paints a layer, then places it above or below the source image. */
function applyLayer(src: ImageData, paint: (layer: ImageData) => void, background: boolean): ImageData {
    const layer = makeImageData(src.width, src.height);
    paint(layer);
    return background ? compositeTop(layer, src) : compositeTop(src, layer);
}

/** Rotated rectangle with a one-pixel analytic edge. */
function fillRotatedRect(
    img: ImageData,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    angle: number,
    color: RGBA,
    alpha: number
): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const reach = Math.sqrt(halfW * halfW + halfH * halfH) + 1;
    const x0 = Math.max(0, Math.floor(cx - reach));
    const x1 = Math.min(img.width - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(img.height - 1, Math.ceil(cy + reach));
    const d = img.data;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const lx = Math.abs(dx * cos + dy * sin) - halfW;
            const ly = Math.abs(-dx * sin + dy * cos) - halfH;
            const outside = Math.max(lx, ly);
            const cov = outside <= -0.5 ? 1 : outside >= 0.5 ? 0 : 0.5 - outside;
            if (cov > 0) {
                overPixel(d, (y * img.width + x) * 4, color, cov * alpha);
            }
        }
    }
}

/** Soft (feathered) rotated ellipse, used for particle / flake cores. */
function fillSoftEllipse(
    img: ImageData,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    angle: number,
    color: RGBA,
    alpha: number,
    hardness: number
): void {
    const ax = Math.max(0.5, rx);
    const ay = Math.max(0.5, ry);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const reach = Math.max(ax, ay) + 1;
    const x0 = Math.max(0, Math.floor(cx - reach));
    const x1 = Math.min(img.width - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(img.height - 1, Math.ceil(cy + reach));
    const d = img.data;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const lx = (dx * cos + dy * sin) / ax;
            const ly = (-dx * sin + dy * cos) / ay;
            const r = Math.sqrt(lx * lx + ly * ly);
            const cov = 1 - smoothstep(hardness, 1, r);
            if (cov > 0) {
                overPixel(d, (y * img.width + x) * 4, color, cov * alpha);
            }
        }
    }
}

/** Soft capsule from (x0,y0) to (x1,y1); snowflake arms and spokes. */
function fillCapsule(
    img: ImageData,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    color: RGBA,
    alpha: number
): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    const hw = Math.max(0.35, halfWidth);
    const feather = Math.max(0.4, hw);
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - hw - feather));
    const bx1 = Math.min(img.width - 1, Math.ceil(Math.max(x0, x1) + hw + feather));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - hw - feather));
    const by1 = Math.min(img.height - 1, Math.ceil(Math.max(y0, y1) + hw + feather));
    const d = img.data;
    for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
            const t = lenSq > 0 ? clamp(((x - x0) * dx + (y - y0) * dy) / lenSq, 0, 1) : 0;
            const qx = x - (x0 + dx * t);
            const qy = y - (y0 + dy * t);
            const dist = Math.sqrt(qx * qx + qy * qy);
            const out = dist - hw;
            const cov = out <= -feather ? 1 : out >= feather ? 0 : (feather - out) / (2 * feather);
            if (cov > 0) {
                overPixel(d, (y * img.width + x) * 4, color, cov * alpha);
            }
        }
    }
}

/** Filled rounded rectangle with an analytic signed distance. */
function fillRoundRect(
    img: ImageData,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: RGBA,
    alpha: number
): void {
    if (width <= 0 || height <= 0) {
        return;
    }
    const r = clamp(radius, 0, Math.min(width, height) / 2);
    const cx = x + width / 2;
    const cy = y + height / 2;
    const hx = width / 2 - r;
    const hy = height / 2 - r;
    const x0 = Math.max(0, Math.floor(x) - 1);
    const x1 = Math.min(img.width - 1, Math.ceil(x + width) + 1);
    const y0 = Math.max(0, Math.floor(y) - 1);
    const y1 = Math.min(img.height - 1, Math.ceil(y + height) + 1);
    const d = img.data;
    for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
            const qx = Math.abs(px - cx) - hx;
            const qy = Math.abs(py - cy) - hy;
            const outside = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0));
            const inside = Math.min(Math.max(qx, qy), 0);
            const sd = outside + inside - r;
            const cov = clamp(0.5 - sd, 0, 1);
            if (cov > 0) {
                overPixel(d, (py * img.width + px) * 4, color, cov * alpha);
            }
        }
    }
}

// ------------------------------------------------------------------- effects

/** Checkerboard painted behind the image, transparent areas only. */
const drawCheckerboard: EffectImpl = (src, params, env) => {
    const cell = pxInt(env, num(params, "size", 10));
    const color1 = parseColor(strOf(params, "color", "#D3D3D3"));
    const color2 = parseColor(strOf(params, "color2", "#FFFFFF"));
    const layer = makeImageData(src.width, src.height);
    const d = layer.data;
    for (let y = 0; y < layer.height; y++) {
        const row = Math.floor(y / cell);
        for (let x = 0; x < layer.width; x++) {
            const color = (row + Math.floor(x / cell)) % 2 === 0 ? color1 : color2;
            const i = (y * layer.width + x) * 4;
            d[i] = color[0];
            d[i + 1] = color[1];
            d[i + 2] = color[2];
            d[i + 3] = color[3];
        }
    }
    return compositeTop(layer, src);
};

const CONFETTI_COLORS: number[][] = [
    [255, 56, 96],
    [255, 165, 0],
    [255, 215, 0],
    [0, 200, 83],
    [0, 176, 255],
    [156, 39, 176],
    [255, 64, 129],
    [0, 230, 118],
    [255, 234, 0],
    [29, 233, 182],
];

/** Seeded confetti strips over (or behind) the image. */
const confetti: EffectImpl = (src, params, env) => {
    const count = Math.max(0, Math.round(num(params, "count", 150)));
    const opacity = clamp(num(params, "opacity", 90), 0, 100) / 100;
    if (count <= 0 || opacity <= 0) {
        return cloneImageData(src);
    }
    const background = boolOf(params, "background", false);
    const minRaw = num(params, "min_size", 4);
    const maxRaw = num(params, "max_size", 12);
    const minSize = pxSize(env, Math.min(minRaw, maxRaw), 1);
    const maxSize = pxSize(env, Math.max(minRaw, maxRaw), minSize);
    const rand = mulberry32(deriveSeed(env.seed, "confetti"));
    return applyLayer(
        src,
        (layer) => {
            for (let i = 0; i < count; i++) {
                const x = rand() * layer.width;
                const y = rand() * layer.height;
                const size = minSize + rand() * (maxSize - minSize);
                const angle = rand() * Math.PI * 2;
                const color = CONFETTI_COLORS[Math.floor(rand() * CONFETTI_COLORS.length) % CONFETTI_COLORS.length];
                fillRotatedRect(
                    layer,
                    x,
                    y,
                    size / 2,
                    Math.max(1, size * 0.24),
                    angle,
                    [color[0], color[1], color[2], 255],
                    opacity
                );
            }
        },
        background
    );
};

/** Seeded soft snowflakes with six arms and a glow. */
const snowflakes: EffectImpl = (src, params, env) => {
    const count = Math.max(0, Math.round(num(params, "count", 80)));
    const opacity = clamp(num(params, "opacity", 85), 0, 100) / 100;
    if (count <= 0 || opacity <= 0) {
        return cloneImageData(src);
    }
    const background = boolOf(params, "background", false);
    const randomAngle = boolOf(params, "random_angle", true);
    const minRaw = num(params, "min_size", 3);
    const maxRaw = num(params, "max_size", 14);
    const minSize = pxSize(env, Math.min(minRaw, maxRaw), 1);
    const maxSize = pxSize(env, Math.max(minRaw, maxRaw), minSize);
    const rand = mulberry32(deriveSeed(env.seed, "snowflakes"));
    return applyLayer(
        src,
        (layer) => {
            for (let i = 0; i < count; i++) {
                const cx = rand() * layer.width;
                const cy = rand() * layer.height;
                const size = minSize + rand() * (maxSize - minSize);
                const alpha = opacity * (0.5 + rand() * 0.5);
                const rotation = randomAngle ? rand() * Math.PI * 2 : 0;
                const half = size / 2;
                fillSoftEllipse(layer, cx, cy, half * 1.15, half * 1.15, 0, [200, 220, 255, 255], alpha * 0.35, 0);
                for (let arm = 0; arm < 6; arm++) {
                    const angle = rotation + (arm * Math.PI) / 3;
                    const cos = Math.cos(angle);
                    const sin = Math.sin(angle);
                    fillCapsule(
                        layer,
                        cx,
                        cy,
                        cx + cos * half,
                        cy + sin * half,
                        Math.max(0.5, size * 0.05),
                        [242, 248, 255, 255],
                        alpha
                    );
                    if (size >= 6) {
                        const midX = cx + cos * half * 0.55;
                        const midY = cy + sin * half * 0.55;
                        const branchLen = half * 0.35;
                        for (let side = -1; side <= 1; side += 2) {
                            const sideAngle = angle + side * (Math.PI / 3);
                            fillCapsule(
                                layer,
                                midX,
                                midY,
                                midX + Math.cos(sideAngle) * branchLen,
                                midY + Math.sin(sideAngle) * branchLen,
                                Math.max(0.4, size * 0.04),
                                [242, 248, 255, 255],
                                alpha * 0.9
                            );
                        }
                    }
                }
                fillSoftEllipse(layer, cx, cy, Math.max(0.6, size * 0.1), Math.max(0.6, size * 0.1), 0, [255, 255, 255, 255], alpha, 0);
            }
        },
        background
    );
};

interface RectF {
    x: number;
    y: number;
    w: number;
    h: number;
}

function intersects(a: RectF, b: RectF, inflate: number): boolean {
    return (
        a.x - inflate < b.x + b.w &&
        a.x + a.w + inflate > b.x &&
        a.y - inflate < b.y + b.h &&
        a.y + a.h + inflate > b.y
    );
}

/** Soft seeded particle dots (the image folder is unusable in a browser). */
const drawParticles: EffectImpl = (src, params, env) => {
    const count = Math.max(1, Math.round(num(params, "image_count", 1)));
    const background = boolOf(params, "background", false);
    const randomSize = boolOf(params, "random_size", false);
    const randomAngle = boolOf(params, "random_angle", false);
    const randomOpacity = boolOf(params, "random_opacity", false);
    const noOverlap = boolOf(params, "no_overlap", false);
    const edgeOverlap = boolOf(params, "edge_overlap", false);
    const sizeMin = num(params, "random_size_min", 64);
    const sizeMax = num(params, "random_size_max", 128);
    const angleMin = num(params, "random_angle_min", 0);
    const angleMax = num(params, "random_angle_max", 360);
    const opacityMin = num(params, "random_opacity_min", 0);
    const opacityMax = num(params, "random_opacity_max", 100);
    const overlapOffset = Math.max(0, Math.round(env.px(num(params, "no_overlap_offset", 0))));
    const rand = mulberry32(deriveSeed(env.seed, "particles"));
    return applyLayer(
        src,
        (layer) => {
            const placed: RectF[] = [];
            for (let i = 0; i < count; i++) {
                const rawSize = randomSize
                    ? Math.min(sizeMin, sizeMax) + rand() * Math.abs(sizeMax - sizeMin)
                    : Math.min(sizeMin, sizeMax);
                const size = Math.max(1, Math.round(env.px(rawSize)));
                const angleDeg = randomAngle ? pickInt(rand, angleMin, angleMax) : 0;
                const opacityPct = randomOpacity ? pickInt(rand, opacityMin, opacityMax) : 100;
                const alpha = clamp(opacityPct, 0, 100) / 100;
                if (alpha <= 0) {
                    continue;
                }
                const minX = edgeOverlap ? -size + 1 : 0;
                const minY = edgeOverlap ? -size + 1 : 0;
                const maxX = layer.width - (edgeOverlap ? 0 : size) - 1;
                const maxY = layer.height - (edgeOverlap ? 0 : size) - 1;
                let rect: RectF = { x: minX, y: minY, w: size, h: size };
                let accepted = !noOverlap;
                const attempts = noOverlap ? 1000 : 1;
                for (let attempt = 0; attempt < attempts; attempt++) {
                    rect = {
                        x: pickInt(rand, minX, maxX),
                        y: pickInt(rand, minY, maxY),
                        w: size,
                        h: size,
                    };
                    if (noOverlap && placed.some((other) => intersects(rect, other, overlapOffset))) {
                        continue;
                    }
                    accepted = true;
                    break;
                }
                if (!accepted) {
                    continue;
                }
                placed.push(rect);
                const cx = rect.x + rect.w / 2;
                const cy = rect.y + rect.h / 2;
                fillSoftEllipse(
                    layer,
                    cx,
                    cy,
                    rect.w / 2,
                    Math.max(1, rect.h * 0.45),
                    (angleDeg * Math.PI) / 180,
                    [238, 244, 255, 255],
                    alpha,
                    0.2
                );
            }
        },
        background
    );
};

/** Two-colour linear gradient blended with Overlay, like the Skia source. */
const gradientOverlay: EffectImpl = (src, params, env) => {
    const alpha = clamp(num(params, "opacity", 50), 0, 100) / 100;
    if (alpha <= 0) {
        return cloneImageData(src);
    }
    const c1 = parseColor(strOf(params, "color1", "#FF0080"));
    const c2 = parseColor(strOf(params, "color2", "#0080FF"));
    const rad = (num(params, "angle", 0) * Math.PI) / 180;
    const w = src.width;
    const h = src.height;
    const cx = w / 2;
    const cy = h / 2;
    const diagonal = Math.sqrt(w * w + h * h) / 2;
    const dirX = Math.cos(rad);
    const dirY = Math.sin(rad);
    const startX = cx - dirX * diagonal;
    const startY = cy - dirY * diagonal;
    const span = Math.max(1e-6, diagonal * 2);
    const out = makeImageData(w, h);
    const s = src.data;
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const t = clamp(((x + 0.5 - startX) * dirX + (y + 0.5 - startY) * dirY) / span, 0, 1);
            const sr = (c1[0] + (c2[0] - c1[0]) * t) / 255;
            const sg = (c1[1] + (c2[1] - c1[1]) * t) / 255;
            const sb = (c1[2] + (c2[2] - c1[2]) * t) / 255;
            const sa = ((c1[3] + (c2[3] - c1[3]) * t) / 255) * alpha;
            for (let channel = 0; channel < 3; channel++) {
                const base = s[i + channel] / 255;
                const blend = base <= 0.5 ? 2 * base * (channel === 0 ? sr : channel === 1 ? sg : sb) : 1 - 2 * (1 - base) * (1 - (channel === 0 ? sr : channel === 1 ? sg : sb));
                d[i + channel] = clamp255((base + (blend - base) * sa) * 255);
            }
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

/** Rounded label with background, border, shadow and text. */
const textWatermark: EffectImpl = (src, params, env) => {
    const text = strOf(params, "text", "Text watermark");
    if (!text.trim()) {
        return cloneImageData(src);
    }
    const fontPx = pxSize(env, num(params, "font_size", 15), 1);
    const padLeft = pxSize(env, num(params, "padding_left", 5), 0);
    const padTop = pxSize(env, num(params, "padding_top", 5), 0);
    const padRight = pxSize(env, num(params, "padding_right", 5), 0);
    const padBottom = pxSize(env, num(params, "padding_bottom", 5), 0);
    const cornerRadius = pxSize(env, num(params, "corner_radius", 4), 0);
    const offX = env.px(num(params, "offset_x", 5));
    const offY = env.px(num(params, "offset_y", 5));
    const placement = strOf(params, "placement", "BottomRight");
    const autoHide = boolOf(params, "auto_hide", false);
    const bold = boolOf(params, "bold", false);
    const italic = boolOf(params, "italic", false);
    const fontFamily = strOf(params, "font_family", "Arial") || "Arial";
    const textColor = parseColor(strOf(params, "text_color", "#EBEBEB"));
    const drawShadow = boolOf(params, "draw_text_shadow", false);
    const shadowColor = parseColor(strOf(params, "text_shadow_color", "#000000"));
    const shadowX = env.px(num(params, "text_shadow_offset_x", -1));
    const shadowY = env.px(num(params, "text_shadow_offset_y", -1));
    const drawBorder = boolOf(params, "draw_border", true);
    const borderColor = parseColor(strOf(params, "border_color", "#000000"));
    const borderSize = pxSize(env, num(params, "border_size", 1), 0);
    const drawBackground = boolOf(params, "draw_background", true);
    const backgroundColor = parseColor(strOf(params, "background_color", "#2A2F38"));

    const lines = text.replace(/\r\n/g, "\n").split("\n");

    const position = (boxW: number, boxH: number): { x: number; y: number } => {
        const midX = Math.round(src.width / 2 - boxW / 2);
        const midY = Math.round(src.height / 2 - boxH / 2);
        const right = src.width - boxW;
        const bottom = src.height - boxH;
        switch (placement) {
            case "TopCenter":
                return { x: midX, y: offY };
            case "TopRight":
                return { x: right - offX, y: offY };
            case "MiddleLeft":
                return { x: offX, y: midY };
            case "MiddleCenter":
                return { x: midX, y: midY };
            case "MiddleRight":
                return { x: right - offX, y: midY };
            case "BottomLeft":
                return { x: offX, y: bottom - offY };
            case "BottomCenter":
                return { x: midX, y: bottom - offY };
            case "BottomRight":
                return { x: right - offX, y: bottom - offY };
            default:
                return { x: offX, y: offY };
        }
    };

    const visible = (x: number, y: number, boxW: number, boxH: number): boolean =>
        !autoHide || (x >= 0 && y >= 0 && x + boxW <= src.width && y + boxH <= src.height);

    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    const ctx = canvas ? canvas.getContext("2d") : null;
    if (canvas && ctx) {
        canvas.width = src.width;
        canvas.height = src.height;
        ctx.putImageData(src, 0, 0);
        const family = fontFamily.includes(" ") ? `"${fontFamily}"` : fontFamily;
        ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontPx}px ${family}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        let textWidth = 0;
        let ascent = 0;
        let descent = 0;
        for (const line of lines) {
            const metrics = ctx.measureText(line);
            textWidth = Math.max(textWidth, metrics.width);
            const up = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : 0;
            const down = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : 0;
            ascent = Math.max(ascent, up > 0 ? up : fontPx * 0.8);
            descent = Math.max(descent, down > 0 ? down : fontPx * 0.2);
        }
        const rawHeight = Math.max(ascent + descent, fontPx);
        const lineHeight = rawHeight;
        const boxW = Math.ceil(textWidth + padLeft + padRight);
        const boxH = Math.ceil(rawHeight + (lines.length - 1) * lineHeight + padTop + padBottom);
        if (boxW <= 0 || boxH <= 0) {
            return cloneImageData(src);
        }
        const { x, y } = position(boxW, boxH);
        if (!visible(x, y, boxW, boxH)) {
            return cloneImageData(src);
        }
        const radius = Math.min(cornerRadius, Math.min(boxW, boxH) / 2);
        ctx.beginPath();
        traceRoundRect(ctx, x, y, boxW, boxH, radius);
        if (drawBackground && backgroundColor[3] > 0) {
            ctx.fillStyle = cssColor(backgroundColor);
            ctx.fill();
        }
        if (drawBorder && borderColor[3] > 0) {
            ctx.strokeStyle = cssColor(borderColor);
            ctx.lineWidth = Math.max(1, borderSize);
            traceRoundRect(ctx, x, y, boxW, boxH, radius);
            ctx.stroke();
        }
        const textX = x + padLeft;
        const baseline = y + padTop + ascent;
        if (drawShadow && shadowColor[3] > 0) {
            ctx.fillStyle = cssColor(shadowColor);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].length > 0) {
                    ctx.fillText(lines[i], textX + shadowX, baseline + i * lineHeight + shadowY);
                }
            }
        }
        ctx.fillStyle = cssColor(textColor);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > 0) {
                ctx.fillText(lines[i], textX, baseline + i * lineHeight);
            }
        }
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    // Node / no-canvas fallback: translucent rounded label without glyphs.
    const rawHeight = fontPx * 1.2;
    const lineHeight = rawHeight;
    let maxChars = 0;
    for (const line of lines) {
        maxChars = Math.max(maxChars, line.length);
    }
    const boxW = Math.ceil(maxChars * fontPx * 0.55 + padLeft + padRight);
    const boxH = Math.ceil(rawHeight + (lines.length - 1) * lineHeight + padTop + padBottom);
    if (boxW <= 0 || boxH <= 0) {
        return cloneImageData(src);
    }
    const { x, y } = position(boxW, boxH);
    if (!visible(x, y, boxW, boxH)) {
        return cloneImageData(src);
    }
    const out = cloneImageData(src);
    const radius = Math.min(cornerRadius, Math.min(boxW, boxH) / 2);
    if (drawBackground && backgroundColor[3] > 0) {
        fillRoundRect(out, x, y, boxW, boxH, radius, backgroundColor, (backgroundColor[3] / 255) * 0.7);
    } else if (drawBorder && borderColor[3] > 0) {
        fillRoundRect(out, x, y, boxW, boxH, radius, borderColor, (borderColor[3] / 255) * 0.5);
    }
    return out;
};

/** CSS rgba() string from a parsed colour, safe for 8-digit hex sources. */
function cssColor(color: RGBA): string {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`;
}

/** Rounded-rect path helper (canvas picks the fallback font upstream). */
function traceRoundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number
): void {
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ------------------------------------------------------------------ registry

export const DRAWING_IMPLS: EffectRegistry = {
    draw_checkerboard: drawCheckerboard,
    confetti,
    snowflakes,
    draw_particles: drawParticles,
    gradient_overlay: gradientOverlay,
    text_watermark: textWatermark,
};

/** This batch never expands the canvas. */
export const DRAWING_FRAME_IDS: string[] = [];
