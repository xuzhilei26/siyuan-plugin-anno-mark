/**
 * F3 filter effects — light, glass/materials, weather and overlay batch (43 ids).
 *
 * Ports ShareX.ImageEditor `Filters/*` onto the shared ops library. Spatial
 * parameters (radius, size, distance, spacing, cell size, width…) are scaled
 * with `env.px()` so preview and export match; 0..100 amounts are not scaled.
 * Every particle / noise field is seeded from `env.seed`, so repeated renders
 * are byte-identical.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    luminance,
    makeImageData,
    parseColor,
    smoothstep,
} from "../pixels.ts";
import { deriveSeed, mulberry32 } from "../rand.ts";
import type { EffectEnv, EffectImpl, EffectRegistry, Insets, ParamDict } from "../types.ts";
import {
    cloudField,
    displacementMap,
    frostField,
    fbm,
    gaussianBlur,
    heatHaze,
    motionBlur,
    rustField,
    sampleBilinear,
    smokeField,
    sobelEdge,
    valueNoise2D,
    withFrame,
} from "../ops/index.ts";

type RGB = [number, number, number];

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

function rgbOf(params: ParamDict, key: string, fallback: string): RGB {
    const c = parseColor(strOf(params, key, fallback));
    return [c[0], c[1], c[2]];
}

/** Scales a pixel-unit value to the current render resolution. */
function pxOf(env: EffectEnv, value: number, min = 1): number {
    return Math.max(min, env.px(value));
}

/** Integer pixel size, useful for block / cell sizes. */
function cellOf(env: EffectEnv, value: number, min = 1): number {
    return Math.max(min, Math.round(env.px(value)));
}

// --------------------------------------------------------------- pixel utils

function hash01(x: number, y: number, seed: number): number {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function lumField(src: ImageData): Float32Array {
    const n = src.width * src.height;
    const out = new Float32Array(n);
    const d = src.data;
    for (let i = 0, p = 0; p < n; i += 4, p++) {
        out[p] = luminance(d[i], d[i + 1], d[i + 2]) / 255;
    }
    return out;
}

/** Smooth bright-pass mask: 0 below `low`, 1 above `high` (0..1 luminance). */
function brightMask(src: ImageData, low: number, high: number): Float32Array {
    const field = lumField(src);
    const out = new Float32Array(field.length);
    for (let i = 0; i < field.length; i++) {
        out[i] = smoothstep(low, high, field[i]);
    }
    return out;
}

/** Paints a coverage field into a coloured layer (alpha carries the coverage). */
function maskLayer(mask: Float32Array, w: number, h: number, color: RGB, gain = 1): ImageData {
    const out = makeImageData(w, h);
    const d = out.data;
    for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
        const a = clamp(mask[p] * gain, 0, 1);
        d[i] = color[0];
        d[i + 1] = color[1];
        d[i + 2] = color[2];
        d[i + 3] = a * 255;
    }
    return out;
}

/** Screen-blends `layer` over `base` using the layer alpha as coverage. */
function screenLayer(base: ImageData, layer: ImageData, amount = 1): ImageData {
    const out = cloneImageData(base);
    const b = out.data;
    const l = layer.data;
    const amt = clamp(amount, 0, 4);
    for (let i = 0; i < b.length; i += 4) {
        const cov = (l[i + 3] / 255) * amt;
        if (cov <= 0) {
            continue;
        }
        for (let c = 0; c < 3; c++) {
            const src = b[i + c] / 255;
            const over = (l[i + c] / 255) * cov;
            b[i + c] = clamp255((1 - (1 - src) * (1 - over)) * 255);
        }
    }
    return out;
}

/** Additive blend using the layer alpha as coverage. */
function addLayer(base: ImageData, layer: ImageData, amount = 1): ImageData {
    const out = cloneImageData(base);
    const b = out.data;
    const l = layer.data;
    const amt = clamp(amount, 0, 4);
    for (let i = 0; i < b.length; i += 4) {
        const cov = (l[i + 3] / 255) * amt;
        if (cov <= 0) {
            continue;
        }
        b[i] = clamp255(b[i] + l[i] * cov);
        b[i + 1] = clamp255(b[i + 1] + l[i + 1] * cov);
        b[i + 2] = clamp255(b[i + 2] + l[i + 2] * cov);
    }
    return out;
}

/** Blurs a 0..1 field by round-tripping through a grayscale ImageData. */
function blurField(field: Float32Array, w: number, h: number, radius: number): Float32Array {
    if (radius < 0.5) {
        return field.slice();
    }
    const img = makeImageData(w, h);
    const d = img.data;
    for (let i = 0, p = 0; p < field.length; i += 4, p++) {
        const v = clamp255(field[p] * 255);
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
    }
    const blurred = gaussianBlur(img, radius);
    const out = new Float32Array(field.length);
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
        out[p] = blurred.data[i] / 255;
    }
    return out;
}

/** Evaluates a smooth field on a coarse grid and bilinearly upscales it. */
function coarseField(
    w: number,
    h: number,
    cell: number,
    sample: (x: number, y: number) => number
): Float32Array {
    const c = Math.max(1, Math.round(cell));
    const gw = Math.ceil(w / c) + 1;
    const gh = Math.ceil(h / c) + 1;
    const grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
            grid[gy * gw + gx] = sample(gx * c, gy * c);
        }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const fy = y / c;
        const y0 = Math.min(gh - 1, Math.floor(fy));
        const y1 = Math.min(gh - 1, y0 + 1);
        const ty = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = x / c;
            const x0 = Math.min(gw - 1, Math.floor(fx));
            const x1 = Math.min(gw - 1, x0 + 1);
            const tx = fx - x0;
            const a = grid[y0 * gw + x0];
            const b = grid[y0 * gw + x1];
            const cc = grid[y1 * gw + x0];
            const dd = grid[y1 * gw + x1];
            out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (cc + (dd - cc) * tx) * ty;
        }
    }
    return out;
}

/** Clamped cell of the coarse field size used by the procedural weather effects. */
function coarseCell(w: number, h: number): number {
    return Math.max(1, Math.round(Math.min(w, h) / 220));
}

/** Replaces warp holes (alpha 0) with the original pixel so frames stay solid. */
function fillHoles(out: ImageData, src: ImageData): ImageData {
    const d = out.data;
    const s = src.data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0 && s[i + 3] !== 0) {
            d[i] = s[i];
            d[i + 1] = s[i + 1];
            d[i + 2] = s[i + 2];
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Stamps a soft radial blob, keeping the maximum coverage so far. */
function stampField(
    field: Float32Array,
    w: number,
    h: number,
    cx: number,
    cy: number,
    radius: number,
    strength: number
): void {
    const r = Math.max(1, radius);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy) / r;
            if (dist >= 1) {
                continue;
            }
            const falloff = 1 - dist * dist;
            const v = strength * falloff * falloff;
            const p = y * w + x;
            if (v > field[p]) {
                field[p] = v;
            }
        }
    }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const mx = Math.max(rn, gn, bn);
    const mn = Math.min(rn, gn, bn);
    const l = (mx + mn) / 2;
    let h = 0;
    let s = 0;
    if (mx !== mn) {
        const delta = mx - mn;
        s = l > 0.5 ? delta / (2 - mx - mn) : delta / (mx + mn);
        if (mx === rn) {
            h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
        } else if (mx === gn) {
            h = ((bn - rn) / delta + 2) / 6;
        } else {
            h = ((rn - gn) / delta + 4) / 6;
        }
    }
    return [h * 360, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number, out: RGB): void {
    const hue = ((h % 360) + 360) % 360 / 360;
    const sat = clamp(s, 0, 100) / 100;
    const light = clamp(l, 0, 100) / 100;
    if (sat === 0) {
        const v = light * 255;
        out[0] = v;
        out[1] = v;
        out[2] = v;
        return;
    }
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;
    const hueTo = (t: number): number => {
        let tt = t;
        if (tt < 0) {
            tt += 1;
        }
        if (tt > 1) {
            tt -= 1;
        }
        if (tt < 1 / 6) {
            return p + (q - p) * 6 * tt;
        }
        if (tt < 1 / 2) {
            return q;
        }
        if (tt < 2 / 3) {
            return p + (q - p) * (2 / 3 - tt) * 6;
        }
        return p;
    };
    out[0] = hueTo(hue + 1 / 3) * 255;
    out[1] = hueTo(hue) * 255;
    out[2] = hueTo(hue - 1 / 3) * 255;
}

/** Rotates one pixel's hue by `degrees`, keeping saturation and lightness. */
function shiftHuePixel(r: number, g: number, b: number, degrees: number, out: RGB): void {
    const [h, s, l] = rgbToHsl(r, g, b);
    hslToRgb(h + degrees, s, l, out);
}

/** Accumulates a bright-pass field along one direction with a linear falloff. */
function directionalStreak(
    field: Float32Array,
    w: number,
    h: number,
    dx: number,
    dy: number,
    steps: number,
    stepPx: number
): Float32Array {
    const out = new Float32Array(w * h);
    const ox = Math.round(dx * stepPx);
    const oy = Math.round(dy * stepPx);
    if (ox === 0 && oy === 0) {
        return out;
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = 1; k <= steps; k++) {
                const sx = x + ox * k;
                const sy = y + oy * k;
                if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
                    break;
                }
                acc += field[sy * w + sx] * (1 - k / (steps + 1));
            }
            out[y * w + x] = acc;
        }
    }
    return out;
}

// ------------------------------------------------------------- light effects

const anamorphicLensFlare: EffectImpl = (src, params, env) => {
    const intensity = clamp(num(params, "intensity", 60), 0, 100) / 100;
    if (intensity <= 0.001) {
        return cloneImageData(src);
    }
    const threshold = clamp(num(params, "threshold", 72), 0, 100) / 100;
    const streakLength = clamp(num(params, "streak_length", 55), 0, 100) / 100;
    const warmth = clamp(num(params, "warmth", 45), 0, 100) / 100;
    const ghosting = clamp(num(params, "ghosting", 35), 0, 100) / 100;
    const w = src.width;
    const h = src.height;

    const mask = brightMask(src, threshold, Math.min(1, threshold + 0.26));
    // Wide, soft light: build the streak at reduced resolution so the long
    // motion blur remains affordable on large previews.
    const step = Math.max(1, Math.round(Math.min(w, h) / 200));
    const lw = Math.max(4, Math.ceil(w / step));
    const lh = Math.max(4, Math.ceil(h / step));
    const lowPass = makeImageData(lw, lh);
    for (let y = 0; y < lh; y++) {
        const sy = Math.min(h - 1, Math.round(y * step));
        for (let x = 0; x < lw; x++) {
            const sx = Math.min(w - 1, Math.round(x * step));
            const sp = sy * w + sx;
            const m = mask[sp];
            const o = (y * lw + x) * 4;
            lowPass.data[o] = src.data[sp * 4] * m;
            lowPass.data[o + 1] = src.data[sp * 4 + 1] * m;
            lowPass.data[o + 2] = src.data[sp * 4 + 2] * m;
            lowPass.data[o + 3] = m * 255;
        }
    }

    const streakDist = pxOf(env, 4 + streakLength * 70);
    const streakBlur = pxOf(env, 1 + streakLength * 4, 0);
    const lowStreak = gaussianBlur(
        motionBlur(lowPass, Math.min(200, Math.max(2, streakDist / step)), 0),
        Math.min(30, Math.max(0.5, streakBlur / step))
    );
    const streak = makeImageData(w, h);
    const px4 = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            const lx = Math.min(lw - 0.5, x / step);
            const ly = Math.min(lh - 0.5, y / step);
            if (!sampleBilinear(lowStreak, lx, ly, px4)) {
                continue;
            }
            streak.data[o] = px4[0];
            streak.data[o + 1] = clamp255(px4[1] * (1 - warmth * 0.16));
            streak.data[o + 2] = clamp255(px4[2] * (1 - warmth * 0.44));
            streak.data[o + 3] = px4[3];
        }
    }

    let bx = (w - 1) / 2;
    let by = (h - 1) / 2;
    let weight = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const m = mask[y * w + x];
            if (m > 0.2) {
                sumX += x * m;
                sumY += y * m;
                weight += m;
            }
        }
    }
    if (weight > 0) {
        bx = sumX / weight;
        by = sumY / weight;
    }
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const rand = mulberry32(deriveSeed(env.seed, "anamorphic"));
    const ghostField = new Float32Array(w * h);
    for (let k = 1; k <= 4; k++) {
        const t = 0.35 + k * 0.42;
        const gx = cx + (bx - cx) * -t + (rand() - 0.5) * env.px(12);
        const gy = cy + (by - cy) * -t + (rand() - 0.5) * env.px(12);
        const radius = env.px(4 + rand() * 9) * (1 + k * 0.35);
        stampField(ghostField, w, h, gx, gy, radius, (0.5 / k) * ghosting);
    }
    const ghostBlur = blurField(ghostField, w, h, Math.max(1, env.px(3)));
    const ghost = maskLayer(ghostBlur, w, h, [255, 236, 208]);

    let out = screenLayer(src, streak, intensity * 0.95);
    out = addLayer(out, ghost, intensity * 0.85);
    return out;
};

const bloom: EffectImpl = (src, params, env) => {
    const threshold = clamp(num(params, "threshold", 65), 0, 100) / 100;
    const knee = clamp(num(params, "soft_knee", 35), 0, 100) / 100;
    const radius = Math.min(60, pxOf(env, clamp(num(params, "radius", 24), 1, 100)));
    const intensity = clamp(num(params, "intensity", 85), 0, 200) / 100;
    if (intensity <= 0.001) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const lum = lumField(src);
    const low = clamp(threshold - knee * 0.5, 0, 1);
    const high = clamp(threshold + knee * 0.5, 0.0001, 1);
    const pass = makeImageData(w, h);
    for (let i = 0, p = 0; i < pass.data.length; i += 4, p++) {
        const v = lum[p];
        const mask = knee > 0 ? smoothstep(low, high, v) : v >= threshold ? 1 : 0;
        const gain = mask * (0.35 + 0.65 * v);
        pass.data[i] = src.data[i] * gain;
        pass.data[i + 1] = src.data[i + 1] * gain;
        pass.data[i + 2] = src.data[i + 2] * gain;
        pass.data[i + 3] = gain * 255;
    }
    const blurred = gaussianBlur(pass, radius);
    return screenLayer(src, blurred, intensity);
};

const dreamGlow: EffectImpl = (src, params, env) => {
    const radius = Math.min(45, pxOf(env, clamp(num(params, "radius", 15), 1, 50)));
    const opacity = clamp(num(params, "opacity", 50), 0, 100) / 100;
    if (opacity <= 0.001) {
        return cloneImageData(src);
    }
    const blurred = gaussianBlur(src, radius);
    const out = screenLayer(src, blurred, opacity * 0.9);
    return addLayer(out, blurred, opacity * 0.16);
};

const glare: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const intensity = clamp(num(params, "intensity", 80), 0, 100) / 100;
    if (intensity <= 0.001) {
        return cloneImageData(src);
    }
    const cx = (clamp(num(params, "position_x", 50), 0, 100) / 100) * w;
    const cy = (clamp(num(params, "position_y", 30), 0, 100) / 100) * h;
    const coreRadius = Math.max(1, env.px(clamp(num(params, "radius", 30), 5, 100)));
    const rays = Math.round(clamp(num(params, "ray_count", 6), 0, 12));
    const rayLength =
        (clamp(num(params, "ray_length", 50), 0, 100) / 100) * Math.max(w, h) * 1.25;
    const color = rgbOf(params, "color", "#FFFFFF");

    const out = cloneImageData(src);
    const d = out.data;
    const coreSigma = Math.max(1, coreRadius * 0.35);
    const raySigma = 0.045 + 0.25 / Math.max(2, rays);
    const rayWeights: number[] = [];
    for (let k = 0; k < rays; k++) {
        rayWeights.push((k * Math.PI * 2) / rays);
    }
    const reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    for (let y = 0; y < h; y++) {
        const dy = y + 0.5 - cy;
        for (let x = 0; x < w; x++) {
            const dx = x + 0.5 - cx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const i = (y * w + x) * 4;
            let value = intensity * 1.15 * Math.exp(-(dist * dist) / (2 * coreSigma * coreSigma));
            if (rays > 0 && rayLength > 0 && dist < rayLength * 1.15) {
                const angle = Math.atan2(dy, dx);
                const radial = Math.exp(-dist / (rayLength * 0.38));
                let angular = 0;
                for (let k = 0; k < rays; k++) {
                    let a = angle - rayWeights[k];
                    while (a > Math.PI) {
                        a -= Math.PI * 2;
                    }
                    while (a < -Math.PI) {
                        a += Math.PI * 2;
                    }
                    angular += Math.exp(-(a * a) / (2 * raySigma * raySigma));
                }
                value += intensity * angular * radial * 0.85;
            }
            if (value <= 0.002) {
                continue;
            }
            const capped = Math.min(1.6, value) * (0.6 + 0.4 * Math.min(1, reach > 0 ? dist / reach : 0));
            d[i] = clamp255(255 * (1 - (1 - d[i] / 255) * (1 - Math.min(1, (color[0] / 255) * capped))));
            d[i + 1] = clamp255(255 * (1 - (1 - d[i + 1] / 255) * (1 - Math.min(1, (color[1] / 255) * capped))));
            d[i + 2] = clamp255(255 * (1 - (1 - d[i + 2] / 255) * (1 - Math.min(1, (color[2] / 255) * capped))));
        }
    }
    return out;
};

const glow: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const size = Math.min(48, pxOf(env, clamp(num(params, "size", 20), 1, 100)));
    const strength = clamp(num(params, "strength", 80), 1, 100) / 100;
    const offsetX = env.px(clamp(num(params, "offset_x", 0), -100, 100));
    const offsetY = env.px(clamp(num(params, "offset_y", 0), -100, 100));
    const color = rgbOf(params, "color", "#FFFFFF");

    const field = new Float32Array(w * h);
    for (let i = 3, p = 0; p < field.length; i += 4, p++) {
        field[p] = src.data[i] / 255;
    }
    const blurred = blurField(field, w, h, size);
    const halo = makeImageData(w, h);
    const hd = halo.data;
    const ox = Math.round(offsetX);
    const oy = Math.round(offsetY);
    for (let y = 0; y < h; y++) {
        const sy = y - oy;
        for (let x = 0; x < w; x++) {
            const sx = x - ox;
            if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
                continue;
            }
            const a = clamp(blurred[sy * w + sx], 0, 1);
            const i = (y * w + x) * 4;
            hd[i] = color[0];
            hd[i + 1] = color[1];
            hd[i + 2] = color[2];
            hd[i + 3] = a * 255 * strength;
        }
    }
    // ShareX paints the halo behind the artwork; the source therefore sits on
    // top of the tinted blur instead of being screened by it (which would wash
    // out fully opaque images).
    const behind = makeImageData(w, h);
    const bd = behind.data;
    const s = src.data;
    for (let i = 0; i < bd.length; i += 4) {
        const sa = s[i + 3] / 255;
        const la = hd[i + 3] / 255;
        const oa = sa + la * (1 - sa);
        if (oa <= 0.0001) {
            continue;
        }
        const k = (la * (1 - sa)) / oa;
        bd[i] = clamp255(s[i] * (1 - k) + hd[i] * k);
        bd[i + 1] = clamp255(s[i + 1] * (1 - k) + hd[i + 1] * k);
        bd[i + 2] = clamp255(s[i + 2] * (1 - k) + hd[i + 2] * k);
        bd[i + 3] = clamp255(oa * 255);
    }
    const highlight = blurField(brightMask(src, 0.5, 0.9), w, h, size);
    return screenLayer(behind, maskLayer(highlight, w, h, color, strength * 0.7));
};

const halation: EffectImpl = (src, params, env) => {
    const threshold = clamp(num(params, "threshold", 72), 0, 100) / 100;
    const radius = Math.min(55, pxOf(env, clamp(num(params, "radius", 18), 1, 100)));
    const strength = clamp(num(params, "strength", 60), 0, 150) / 100;
    const warmth = clamp(num(params, "warmth", 70), 0, 100) / 100;
    if (strength <= 0.001) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const lum = lumField(src);
    const low = clamp(threshold - 0.18, 0, 1);
    const high = clamp(threshold + 0.12, 0.0001, 1);
    const redBoost = 1.2 + 0.65 * warmth;
    const greenBoost = 0.55 + 0.3 * warmth;
    const blueBoost = 0.35 - 0.2 * warmth;
    const pass = makeImageData(w, h);
    for (let i = 0, p = 0; i < pass.data.length; i += 4, p++) {
        const v = lum[p];
        const mask = smoothstep(low, high, v);
        const gain = mask * (0.6 + 0.4 * v);
        pass.data[i] = clamp255(src.data[i] * gain * redBoost);
        pass.data[i + 1] = clamp255(src.data[i + 1] * gain * greenBoost);
        pass.data[i + 2] = clamp255(src.data[i + 2] * gain * blueBoost);
        pass.data[i + 3] = mask * 255;
    }
    const halo = gaussianBlur(pass, radius);
    for (let i = 0; i < halo.data.length; i += 4) {
        halo.data[i] = clamp255(halo.data[i] * (1 + warmth * 0.5));
        halo.data[i + 1] = clamp255(halo.data[i + 1] * (0.85 + warmth * 0.15));
        halo.data[i + 2] = clamp255(halo.data[i + 2] * (0.65 - warmth * 0.25));
    }
    return addLayer(src, halo, strength);
};

const lightLeak: EffectImpl = (src, params, env) => {
    const intensity = clamp(num(params, "intensity", 50), 0, 100) / 100;
    if (intensity <= 0.001) {
        return cloneImageData(src);
    }
    const color = rgbOf(params, "color", "#FFA032");
    const position = strOf(params, "position", "TopRight");
    const w = src.width;
    const h = src.height;
    const rand = mulberry32(deriveSeed(env.seed, "leak"));
    const anchors: Record<string, [number, number]> = {
        TopLeft: [0.02, 0.04],
        TopRight: [0.98, 0.04],
        BottomLeft: [0.02, 0.96],
        BottomRight: [0.98, 0.96],
        Left: [-0.04, 0.5],
        Right: [1.04, 0.5],
    };
    const anchor = anchors[position] ?? anchors.TopRight;
    const ax = anchor[0] + (rand() - 0.5) * 0.12;
    const ay = anchor[1] + (rand() - 0.5) * 0.12;
    const bx = ax + (rand() - 0.5) * 0.35;
    const by = ay + (rand() - 0.5) * 0.35;
    const seed = deriveSeed(env.seed, "leak-noise");
    const cell = coarseCell(w, h);
    const field = coarseField(w, h, cell, (x, y) => {
        const nx = x / w;
        const ny = y / h;
        const d1 = Math.hypot(nx - ax, (ny - ay) * 0.9);
        const d2 = Math.hypot(nx - bx, (ny - by) * 0.9) * 1.35;
        const lobeA = Math.max(0, 1 - d1 * 1.15);
        const lobeB = Math.max(0, 1 - d2) * 0.7;
        const n = fbm((x / w) * 5.5, (y / h) * 5.5, 4, 0.55, 2, seed);
        const streaks = 0.5 + 0.5 * Math.sin((nx * 6 + ny * 2) * Math.PI + n * 7);
        return clamp((lobeA * lobeA + lobeB * lobeB) * (0.45 + 0.55 * n) * (0.7 + 0.3 * streaks), 0, 1);
    });
    const leak = maskLayer(field, w, h, color);
    let out = screenLayer(src, leak, intensity);
    out = addLayer(out, leak, intensity * 0.3);
    return out;
};

const starFilter: EffectImpl = (src, params, env) => {
    const threshold = clamp(num(params, "threshold", 74), 0, 100) / 100;
    const length = clamp(num(params, "length", 40), 4, 80);
    const strength = clamp(num(params, "strength", 58), 0, 100) / 100;
    const rotation = num(params, "rotation", 0);
    const warmth = clamp(num(params, "warmth", 48), 0, 100) / 100;
    if (strength <= 0.001) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const mask = brightMask(src, threshold, Math.min(1, threshold + 0.18));
    for (let i = 0; i < mask.length; i++) {
        mask[i] *= mask[i];
    }
    const steps = Math.round(clamp(length / 6, 3, 9));
    const stepPx = Math.max(1, env.px(length / steps));
    const weights = [1, 1, 0.68, 0.68];
    const agg = new Float32Array(w * h);
    const baseAngle = (rotation * Math.PI) / 180;
    for (let d = 0; d < 4; d++) {
        const angle = baseAngle + (Math.PI / 4) * d + (d >= 2 ? 0 : 0);
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const pos = directionalStreak(mask, w, h, dx, dy, steps, stepPx);
        const neg = directionalStreak(mask, w, h, -dx, -dy, steps, stepPx);
        const weight = weights[d];
        for (let i = 0; i < agg.length; i++) {
            agg[i] += (pos[i] + neg[i]) * weight;
        }
    }
    const norm = 1 / (steps * 2.6);
    const color: RGB = [255, 255 * (0.94 - warmth * 0.1), 255 * (0.82 - warmth * 0.24)];
    const layer = maskLayer(agg, w, h, color, norm);
    return screenLayer(src, layer, strength);
};

const neonEdgeGlow: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const edgeStrength = clamp(num(params, "edge_strength", 2.2), 0.1, 6);
    const threshold = clamp(num(params, "threshold", 36), 0, 255);
    const glowRadius = Math.min(40, pxOf(env, clamp(num(params, "glow_radius", 8), 0, 40), 0));
    const glowIntensity = clamp(num(params, "glow_intensity", 120), 0, 250) / 100;
    const baseDim = clamp(num(params, "base_dim", 30), 0, 100) / 100;
    const neon = rgbOf(params, "neon_color", "#00F0FF");

    const base = cloneImageData(src);
    const dim = 1 - baseDim * 0.9;
    for (let i = 0; i < base.data.length; i += 4) {
        base.data[i] *= dim;
        base.data[i + 1] *= dim;
        base.data[i + 2] *= dim;
    }
    const edges = sobelEdge(src, edgeStrength, threshold);
    const field = new Float32Array(w * h);
    for (let i = 0, p = 0; p < field.length; i += 4, p++) {
        field[p] = edges.data[i] / 255;
    }
    const halo = glowRadius > 0 ? blurField(field, w, h, glowRadius) : field;
    const layer = makeImageData(w, h);
    const d = layer.data;
    for (let p = 0, i = 0; p < field.length; i += 4, p++) {
        const a = clamp(Math.max(field[p] * 0.95, halo[p] * 1.6), 0, 1);
        d[i] = neon[0];
        d[i + 1] = neon[1];
        d[i + 2] = neon[2];
        d[i + 3] = a * 255;
    }
    let out = addLayer(base, layer, glowIntensity * 0.85);
    out = screenLayer(out, layer, glowIntensity * 0.45);
    return out;
};

const plasmaEnergyArcs: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const energy = clamp(num(params, "energy", 65), 0, 100) / 100;
    const density = clamp(num(params, "arc_density", 46), 0, 100) / 100;
    const glowAmount = clamp(num(params, "glow", 70), 0, 100) / 100;
    const turbulence = clamp(num(params, "turbulence", 52), 0, 100) / 100;
    const thickness = clamp(num(params, "thickness", 38), 0, 100) / 100;
    if (energy <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "plasma");
    const rand = mulberry32(seed);
    const arcs = Math.max(1, Math.round(1 + density * 9));
    const brush = Math.max(1, env.px(0.7 + thickness * 2.4));
    const jitter = turbulence * Math.min(w, h) * 0.22;
    const field = new Float32Array(w * h);
    for (let a = 0; a < arcs; a++) {
        const side = Math.floor(rand() * 4);
        let x0 = 0;
        let y0 = 0;
        let x1 = 0;
        let y1 = 0;
        if (side === 0) {
            x0 = rand() * w;
            y0 = -brush;
            x1 = rand() * w;
            y1 = h + brush;
        } else if (side === 1) {
            x0 = -brush;
            y0 = rand() * h;
            x1 = w + brush;
            y1 = rand() * h;
        } else if (side === 2) {
            x0 = rand() * w;
            y0 = h + brush;
            x1 = rand() * w;
            y1 = -brush;
        } else {
            x0 = w + brush;
            y0 = rand() * h;
            x1 = -brush;
            y1 = rand() * h;
        }
        const mx = (x0 + x1) * 0.5 + (rand() - 0.5) * jitter * 2;
        const my = (y0 + y1) * 0.5 + (rand() - 0.5) * jitter * 2;
        const span = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(10, Math.min(220, Math.round(span / Math.max(2, brush))));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const u = 1 - t;
            let px = u * u * x0 + 2 * u * t * mx + t * t * x1;
            let py = u * u * y0 + 2 * u * t * my + t * t * y1;
            px += (valueNoise2D(t * 14, a * 3.7, seed) - 0.5) * jitter * 0.7;
            py += (valueNoise2D(t * 14 + 5, a * 5.1, seed + 9) - 0.5) * jitter * 0.7;
            stampField(field, w, h, px, py, brush, 0.85 + 0.15 * Math.sin(t * Math.PI));
        }
    }
    const halo = blurField(field, w, h, Math.max(1, brush * (1.6 + glowAmount * 2)));
    const core = maskLayer(field, w, h, [226, 250, 255]);
    const aura = maskLayer(halo, w, h, [92, 148, 255], 1.35 * glowAmount);
    let out = addLayer(src, aura, energy * 1.1);
    out = screenLayer(out, core, energy * 0.95);
    return out;
};

// -------------------------------------------------------------- glass & materials

const etchedGlass: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const frost = clamp(num(params, "frost", 48), 0, 100) / 100;
    const engrave = clamp(num(params, "engrave", 68), 0, 100) / 100;
    const refraction = clamp(num(params, "refraction", 18), 0, 100) / 100;
    const highlight = clamp(num(params, "highlight", 42), 0, 100) / 100;
    const fade = clamp(num(params, "background_fade", 38), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "etched-glass");

    const amount = env.px(0.4 + refraction * 6);
    const warped = fillHoles(displacementMap(src, amount, amount * 0.8, undefined, 0, 0, seed), src);
    const base = gaussianBlur(warped, Math.min(12, pxOf(env, 0.4 + frost * 0.06, 0)));
    const d = base.data;
    const spacing = Math.max(2, env.px(3 + (1 - frost) * 6));
    const grooves = engrave * 0.3;
    const sheen = highlight * 0.4;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lineA = Math.abs(Math.sin(((x + y) / spacing) * Math.PI));
            const lineB = Math.abs(Math.sin(((x - y) / spacing) * Math.PI));
            const groove = (1 - Math.pow(Math.max(lineA, lineB), 0.35)) * grooves;
            const band = Math.max(0, 1 - Math.abs((x / w) * 0.55 + (y / h) * 0.45 - 0.32) * 3.2);
            const lift = band * sheen * 165 + groove * 70;
            const wash = fade * 0.5;
            for (let c = 0; c < 3; c++) {
                const v = d[i + c] * (1 - wash) + 226 * wash;
                d[i + c] = clamp255(v - groove * 42 + lift);
            }
        }
    }
    return base;
};

const frostedGlass: EffectImpl = (src, params, env) => {
    const radius = Math.min(20, pxOf(env, clamp(num(params, "radius", 5), 1, 20)));
    return gaussianBlur(src, radius);
};

const frostedGlassIceEdges: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const distortion = clamp(num(params, "distortion", 10), 0, 30);
    const blur = clamp(num(params, "blur", 35), 0, 100) / 100;
    const edgeThreshold = clamp(num(params, "edge_threshold", 28), 1, 120);
    const iceStrength = clamp(num(params, "ice_strength", 75), 0, 100) / 100;
    const tint = clamp(num(params, "tint", 35), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "ice-edges");

    const dAmount = env.px(distortion * 0.9);
    const warped = fillHoles(
        displacementMap(src, dAmount, dAmount * 0.7, undefined, 0, 0, seed + 3),
        src
    );
    const base = gaussianBlur(warped, Math.min(25, pxOf(env, blur * 12, 0)));
    const edges = sobelEdge(warped, 2.4, edgeThreshold);
    const crystals = frostField(w, h, Math.max(4, env.px(14)), seed);

    const d = base.data;
    const e = edges.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const p = y * w + x;
            const edge = e[i] / 255;
            const frost = clamp(edge * iceStrength * 1.35 + crystals[p] * 0.28 * iceStrength, 0, 1);
            // ice tint pulls colours towards a cold cyan
            d[i] = clamp255(d[i] * (1 - tint * 0.35) + frost * (200 + tint * 40));
            d[i + 1] = clamp255(d[i + 1] * (1 - tint * 0.2) + frost * (228 + tint * 20));
            d[i + 2] = clamp255(d[i + 2] * (1 - tint * 0.1) + frost * (255));
        }
    }
    return base;
};

const liquidGlass: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const distortion = clamp(num(params, "distortion", 9), 0, 35);
    const refraction = clamp(num(params, "refraction", 45), 0, 100);
    const chroma = clamp(num(params, "chroma_shift", 1), 0, 8);
    const gloss = clamp(num(params, "gloss", 40), 0, 100) / 100;
    const flow = clamp(num(params, "flow_scale", 100), 40, 220);
    if (distortion <= 0.001 && refraction <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "liquid-glass");
    const wave = Math.max(6, Math.min(w, h) / (2 + flow * 0.06));
    const cell = coarseCell(w, h);
    const f1 = coarseField(w, h, cell, (x, y) => fbm(x / wave, y / wave, 3, 0.55, 2, seed));
    const f2 = coarseField(w, h, cell, (x, y) => fbm(x / wave + 11.3, y / wave - 4.7, 3, 0.55, 2, seed + 31));
    const disp = env.px(distortion * 1.8 + refraction * 0.09);
    const chromaPx = env.px(chroma) * 1.5;
    const out = makeImageData(w, h);
    const d = out.data;
    const s0 = new Float32Array(4);
    const s1 = new Float32Array(4);
    const s2 = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const n1 = f1[p] - 0.5;
            const n2 = f2[p] - 0.5;
            const ox = n1 * disp * 2 + n2 * disp * 0.7;
            const oy = n2 * disp * 2 + n1 * disp * 0.7;
            const ok = sampleBilinear(src, x + ox, y + oy, s1);
            const ok0 = sampleBilinear(src, x + ox - chromaPx, y + oy, s0);
            const ok2 = sampleBilinear(src, x + ox + chromaPx, y + oy, s2);
            const i = p * 4;
            if (!ok) {
                d[i] = src.data[i];
                d[i + 1] = src.data[i + 1];
                d[i + 2] = src.data[i + 2];
                d[i + 3] = src.data[i + 3];
                continue;
            }
            if (!ok0) {
                s0[0] = s1[0];
                s0[1] = s1[1];
                s0[2] = s1[2];
            }
            if (!ok2) {
                s2[0] = s1[0];
                s2[1] = s1[1];
                s2[2] = s1[2];
            }
            const gx = x >= cell ? f1[p] - f1[p - cell] : 0;
            const gy = y >= cell ? f1[p] - f1[p - w * cell] : 0;
            const sheen = gloss * clamp((gx + gy) * 26, 0, 1) * 120;
            d[i] = clamp255(s0[0] + sheen * 1.05);
            d[i + 1] = clamp255(s1[1] + sheen);
            d[i + 2] = clamp255(s2[2] + sheen * 1.1);
            d[i + 3] = s1[3];
        }
    }
    return out;
};

const liquidMercury: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const reflection = clamp(num(params, "reflection", 78), 0, 100) / 100;
    const ripple = clamp(num(params, "ripple", 42), 0, 100) / 100;
    const shine = clamp(num(params, "shine", 82), 0, 100) / 100;
    const fluidity = clamp(num(params, "fluidity", 55), 0, 100) / 100;
    const depth = clamp(num(params, "depth", 65), 0, 100) / 100;
    const smooth = gaussianBlur(src, Math.min(6, pxOf(env, 0.4 + fluidity * 3.4, 0)));
    const wave = Math.max(6, Math.min(w, h) * (0.03 + (1 - fluidity) * 0.07));
    const amp = env.px(ripple * 5);
    const out = makeImageData(w, h);
    const d = out.data;
    const s = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const ox = Math.sin((y / wave) * Math.PI * 2) * amp + Math.sin(x / (wave * 2.3)) * amp * 0.5;
            const oy = Math.cos((x / wave) * Math.PI * 2) * amp * 0.8;
            if (!sampleBilinear(smooth, x + ox, y + oy, s)) {
                d[i] = src.data[i];
                d[i + 1] = src.data[i + 1];
                d[i + 2] = src.data[i + 2];
                d[i + 3] = src.data[i + 3];
                continue;
            }
            const l = luminance(s[0], s[1], s[2]) / 255;
            const metal = clamp(0.1 + Math.pow(l, 0.8) * 1.02, 0, 1);
            const silverR = metal * 228;
            const silverG = metal * 236;
            const silverB = metal * 246;
            const spec = shine * Math.pow(clamp(l * 1.18, 0, 1), 6) * 220;
            const dk = 1 - depth * 0.5 * (1 - l);
            d[i] = clamp255((s[0] * (1 - reflection) + silverR * reflection) * dk + spec);
            d[i + 1] = clamp255((s[1] * (1 - reflection) + silverG * reflection) * dk + spec);
            d[i + 2] = clamp255((s[2] * (1 - reflection) + silverB * reflection) * dk + spec);
            d[i + 3] = s[3];
        }
    }
    return out;
};

const crystalPrism: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const facet = cellOf(env, clamp(num(params, "facetSize", 24), 6, 96), 4);
    const refraction = clamp(num(params, "refraction", 8), 0, 30);
    const dispersion = clamp(num(params, "dispersion", 4), 0, 20);
    const sparkle = clamp(num(params, "sparkle", 25), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "prism");
    const mag = env.px(refraction) * 0.9;
    const disp = env.px(dispersion) * 1.4;
    const out = makeImageData(w, h);
    const d = out.data;
    const c0 = new Float32Array(4);
    const c1 = new Float32Array(4);
    const c2 = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const gx = Math.floor(x / facet);
            const gy = Math.floor(y / facet);
            const u = (x - gx * facet) / facet;
            const v = (y - gy * facet) / facet;
            const tri = u + v > 1 ? 1 : 0;
            const rnd = hash01(gx * 2 + tri, gy * 2 + tri, seed);
            const rnd2 = hash01(gx + 37, gy + 91, seed + 7);
            const ang = rnd * Math.PI * 2;
            const m = mag * (0.35 + rnd2 * 1.1);
            const ox = Math.cos(ang) * m;
            const oy = Math.sin(ang) * m;
            const ok = sampleBilinear(src, x + ox, y + oy, c1);
            const ok0 = sampleBilinear(src, x + ox - disp, y + oy, c0);
            const ok2 = sampleBilinear(src, x + ox + disp, y + oy, c2);
            if (!ok) {
                d[i] = src.data[i];
                d[i + 1] = src.data[i + 1];
                d[i + 2] = src.data[i + 2];
                d[i + 3] = src.data[i + 3];
                continue;
            }
            if (!ok0) {
                c0[0] = c1[0];
                c0[1] = c1[1];
                c0[2] = c1[2];
            }
            if (!ok2) {
                c2[0] = c1[0];
                c2[1] = c1[1];
                c2[2] = c1[2];
            }
            const shade = 0.88 + rnd * 0.28;
            const border = Math.min(u, v, 1 - u, 1 - v);
            const spark = border < 0.045 ? sparkle * (220 + rnd2 * 35) : 0;
            d[i] = clamp255(c0[0] * shade + spark);
            d[i + 1] = clamp255(c1[1] * shade + spark);
            d[i + 2] = clamp255(c2[2] * shade + spark);
            d[i + 3] = c1[3];
        }
    }
    return out;
};

const crystalizeShards: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const size = cellOf(env, clamp(num(params, "shardSize", 22), 6, 80), 4);
    const jitter = clamp(num(params, "jitter", 65), 0, 100) / 100;
    const edgeStrength = clamp(num(params, "edgeStrength", 75), 0, 100) / 100;
    const shine = clamp(num(params, "shine", 30), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "shards");
    const amp = jitter * size * 0.55;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const cx = Math.floor(x / size);
            const cy = Math.floor(y / size);
            let best = Infinity;
            let second = Infinity;
            let bestGx = cx;
            let bestGy = cy;
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const gx = cx + ox;
                    const gy = cy + oy;
                    const rx = hash01(gx, gy, seed);
                    const ry = hash01(gx, gy, seed + 17);
                    const sx = (gx + 0.5) * size + (rx - 0.5) * amp * 2;
                    const sy = (gy + 0.5) * size + (ry - 0.5) * amp * 2;
                    const dist = (x - sx) * (x - sx) + (y - sy) * (y - sy);
                    if (dist < best) {
                        second = best;
                        best = dist;
                        bestGx = gx;
                        bestGy = gy;
                    } else if (dist < second) {
                        second = dist;
                    }
                }
            }
            const edgeDist = Math.sqrt(second) - Math.sqrt(best);
            const edge = clamp(1 - edgeDist / (size * 0.13), 0, 1);
            const rnd = hash01(bestGx, bestGy, seed + 51);
            const offX = (hash01(bestGx, bestGy, seed + 71) - 0.5) * amp;
            const offY = (hash01(bestGx, bestGy, seed + 97) - 0.5) * amp;
            const ok = sampleBilinear(src, x + offX, y + offY, s);
            if (!ok) {
                d[i] = src.data[i];
                d[i + 1] = src.data[i + 1];
                d[i + 2] = src.data[i + 2];
                d[i + 3] = src.data[i + 3];
                continue;
            }
            const shade = 0.9 + rnd * 0.22;
            const rim = edge * edgeStrength * 0.55;
            const glint = edge * shine * (0.3 + rnd * 0.7) * 210;
            d[i] = clamp255(s[0] * shade * (1 - rim) + glint);
            d[i + 1] = clamp255(s[1] * shade * (1 - rim) + glint);
            d[i + 2] = clamp255(s[2] * shade * (1 - rim) + glint);
            d[i + 3] = s[3];
        }
    }
    return out;
};

const oilSlickInterference: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const intensity = clamp(num(params, "intensity", 58), 0, 100) / 100;
    const scale = clamp(num(params, "scale", 70), 0, 100);
    const darkness = clamp(num(params, "darkness", 45), 0, 100) / 100;
    const gloss = clamp(num(params, "gloss", 60), 0, 100) / 100;
    const shift = clamp(num(params, "shift", 0), 0, 360);
    if (intensity <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "oil-slick");
    const wave = Math.max(6, Math.min(w, h) / (1.8 + scale * 0.05));
    const cell = coarseCell(w, h);
    const thickness = coarseField(w, h, cell, (x, y) => {
        const n = fbm(x / wave, y / wave, 4, 0.55, 2, seed);
        const swirl = fbm(x / wave + n * 2.4, y / wave - n * 1.9, 3, 0.5, 2, seed + 13);
        return clamp(swirl * 0.68 + n * 0.32, 0, 1);
    });
    const out = cloneImageData(src);
    const d = out.data;
    const film: RGB = [0, 0, 0];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            const t = thickness[p];
            hslToRgb(shift + t * 520, 88, 14 + (1 - t) * 30, film);
            const gx = x >= cell ? t - thickness[p - cell] : 0;
            const gy = y >= cell ? t - thickness[p - w * cell] : 0;
            const sheen = gloss * clamp((gx + gy) * 22, 0, 1) * 170;
            const k = intensity * (0.35 + 0.65 * t);
            for (let c = 0; c < 3; c++) {
                const base = d[i + c] * (1 - darkness * 0.55);
                d[i + c] = clamp255(base * (1 - k * 0.45) + film[c] * k * 1.15 + sheen);
            }
        }
    }
    return out;
};

const holographicFoilShimmer: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const intensity = clamp(num(params, "intensity", 65), 0, 100) / 100;
    const scale = clamp(num(params, "scale", 120), 40, 300);
    const shift = clamp(num(params, "shift", 0), 0, 360);
    const specular = clamp(num(params, "specular", 45), 0, 100) / 100;
    const grain = clamp(num(params, "grain", 20), 0, 100);
    if (intensity <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "holo-foil");
    const wave = Math.max(3, Math.max(w, h) / (2 + scale * 0.045));
    const out = cloneImageData(src);
    const d = out.data;
    const film: RGB = [0, 0, 0];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const n = valueNoise2D(x / (wave * 2.5), y / (wave * 2.5), seed);
            const diag = (x + y * 0.55) / wave;
            const band = Math.sin(diag * Math.PI * 2 + n * 3.4);
            const hue = shift + ((x + y * 0.55) / Math.max(w, h)) * 320 + n * 90;
            hslToRgb(hue, 92, 54 + band * 9, film);
            const k = intensity * (0.3 + 0.7 * Math.abs(band));
            const spec = specular * Math.pow(clamp(band, 0, 1), 3) * 200;
            const noise = (hash01(x, y, seed + 5) - 0.5) * grain * 1.15;
            for (let c = 0; c < 3; c++) {
                d[i + c] = clamp255(d[i + c] * (1 - k * 0.38) + film[c] * k * 1.2 + spec + noise);
            }
        }
    }
    return out;
};

// ------------------------------------------------------------------- weather

const clouds: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const coverage = clamp(num(params, "coverage", 55), 0, 100);
    const scale = clamp(num(params, "scale", 72), 0, 100);
    const heightBias = clamp(num(params, "heightBias", 62), 0, 100) / 100;
    const softness = clamp(num(params, "softness", 64), 0, 100);
    const sunlight = clamp(num(params, "sunlight", 38), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "clouds");
    const scalePx = Math.max(6, env.px(18 + (100 - scale) * 2.4));
    const field = cloudField(w, h, scalePx, seed, coverage, softness);
    const layer = makeImageData(w, h);
    const d = layer.data;
    const fade = 0.2 + (1 - heightBias) * 0.9;
    for (let y = 0; y < h; y++) {
        const ny = h > 1 ? y / (h - 1) : 0;
        const weight = clamp((1 - ny) / fade, 0, 1);
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            const c = field[p];
            const above = y > 0 ? field[p - w] : c;
            const shade = clamp(0.72 + sunlight * (c - above) * 5 + c * 0.3, 0.35, 1);
            const a = clamp(c * weight * (0.55 + 0.45 * shade), 0, 1);
            d[i] = 252 * shade;
            d[i + 1] = 249 * shade;
            d[i + 2] = 246 * shade;
            d[i + 3] = a * 255;
        }
    }
    return screenLayer(src, layer, 0.9);
};

const rainyWindow: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const distortion = clamp(num(params, "distortion", 8), 0, 30);
    const density = clamp(num(params, "streak_density", 45), 0, 100) / 100;
    const mist = clamp(num(params, "mist_amount", 25), 0, 100) / 100;
    const droplets = clamp(num(params, "droplet_amount", 35), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "rainy-window");
    const rand = mulberry32(seed);

    let base = fillHoles(
        displacementMap(src, env.px(distortion * 0.8), env.px(distortion * 1.2), undefined, 0, 0, seed + 5),
        src
    );
    if (mist > 0.001) {
        const blurred = gaussianBlur(base, Math.min(30, pxOf(env, mist * 26, 0)));
        base = screenLayer(base, blurred, mist * 0.7);
    }

    const streaks = new Float32Array(w * h);
    const streakCount = Math.max(4, Math.round(8 + density * 55));
    for (let s = 0; s < streakCount; s++) {
        const sx = rand() * w;
        const sy = rand() * h * 0.9;
        const len = env.px((0.3 + rand() * 0.9) * (0.35 + density) * 140);
        const width = Math.max(0.8, env.px(0.7 + rand() * 1.4));
        const opacity = 0.25 + rand() * 0.55;
        const steps = Math.max(4, Math.round(len));
        for (let k = 0; k < steps; k++) {
            const yy = sy + k;
            if (yy >= h) {
                break;
            }
            const driftX = sx + Math.sin(k * 0.06 + s) * width * 1.5;
            const t = 1 - k / steps;
            stampField(streaks, w, h, driftX, yy, width, opacity * t);
        }
    }

    const dropletField = new Float32Array(w * h);
    const dropCount = Math.max(2, Math.round(4 + droplets * 46));
    for (let k = 0; k < dropCount; k++) {
        const cx = rand() * w;
        const cy = rand() * h;
        const radius = env.px(1.2 + rand() * 3.4) * (0.6 + droplets * 0.8);
        stampField(dropletField, w, h, cx, cy, radius, 0.3 + rand() * 0.5);
        stampField(dropletField, w, h, cx - radius * 0.5, cy - radius * 0.6, radius * 0.32, 0.9);
    }

    let out = addLayer(base, maskLayer(streaks, w, h, [235, 245, 255]), 0.42);
    out = screenLayer(out, maskLayer(dropletField, w, h, [255, 255, 255]), 0.55);
    return out;
};

const snowfallDepthFog: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const snowAmount = clamp(num(params, "snow_amount", 55), 0, 100) / 100;
    const flakeSize = clamp(num(params, "flake_size", 5), 1, 14);
    const wind = clamp(num(params, "wind", 20), -100, 100) / 100;
    const fogAmount = clamp(num(params, "fog_amount", 40), 0, 100) / 100;
    const fogHeight = clamp(num(params, "fog_height", 65), 10, 100) / 100;
    const seed = deriveSeed(env.seed, "snowfog");
    const rand = mulberry32(seed);

    const out = cloneImageData(src);
    const d = out.data;
    if (fogAmount > 0.001) {
        for (let y = 0; y < h; y++) {
            const ny = h > 1 ? y / (h - 1) : 0;
            const weight = fogAmount * clamp(ny / Math.max(0.05, fogHeight) * 0.9, 0, 1);
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const g = weight * 0.55;
                d[i] = clamp255(d[i] * (1 - g) + 214 * g);
                d[i + 1] = clamp255(d[i + 1] * (1 - g) + 226 * g);
                d[i + 2] = clamp255(d[i + 2] * (1 - g) + 240 * g);
            }
        }
    }

    const flakes = new Float32Array(w * h);
    const count = Math.min(260, Math.round(16 + snowAmount * 244));
    const maxRadius = env.px(flakeSize * 0.5);
    for (let k = 0; k < count; k++) {
        const depth = rand();
        const radius = Math.max(0.7, maxRadius * (0.35 + depth * 0.9));
        const cx = rand() * w + wind * depth * env.px(26);
        const cy = rand() * h;
        const alpha = 0.22 + depth * 0.65;
        stampField(flakes, w, h, cx, cy, radius, alpha);
    }
    const snow = maskLayer(flakes, w, h, [255, 255, 255]);
    return screenLayer(out, snow, 0.85);
};

const smokeOverlay: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const density = clamp(num(params, "density", 42), 0, 100) / 100;
    const scale = clamp(num(params, "scale", 68), 0, 100);
    const drift = clamp(num(params, "drift", 18), -100, 100);
    const softness = clamp(num(params, "softness", 55), 0, 100) / 100;
    const contrast = clamp(num(params, "contrast", 48), 0, 100) / 100;
    if (density <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "smoke");
    const scalePx = Math.max(6, env.px(30 + (100 - scale) * 2));
    const field = smokeField(w, h, scalePx, seed);
    const shift = Math.round(env.px(drift * 1.4));
    const layer = makeImageData(w, h);
    const d = layer.data;
    const lift = 0.35 + contrast * 0.9;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const sx = x - shift;
            const value = sx >= 0 && sx < w ? field[y * w + sx] : 0;
            const contoured = clamp((value - 0.5) * lift + 0.5, 0, 1);
            const a = clamp(contoured * density * (0.5 + softness * 0.9), 0, 1);
            d[i] = 226;
            d[i + 1] = 228;
            d[i + 2] = 232;
            d[i + 3] = a * 255;
        }
    }
    return screenLayer(src, layer, 0.8);
};

const heatHazeRefraction: EffectImpl = (src, params, env) => {
    const strength = clamp(num(params, "strength", 45), 0, 100);
    const frequency = clamp(num(params, "frequency", 40), 0, 100);
    const blurRadius = clamp(num(params, "blur_radius", 10), 0, 200);
    const offset = clamp(num(params, "offset", 6), -200, 200);
    const luminanceInfluence = clamp(num(params, "luminance_influence", 55), 0, 100);
    if (strength <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "heat-haze");
    return fillHoles(
        heatHaze(
            src,
            env.px(strength * 0.4),
            frequency,
            blurRadius * 0.06,
            env.px(offset * 0.4),
            luminanceInfluence,
            seed
        ),
        src
    );
};

const windStreaks: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const length = clamp(num(params, "length", 30), 5, 100);
    const threshold = clamp(num(params, "threshold", 200), 100, 254) / 255;
    const opacity = clamp(num(params, "opacity", 40), 0, 100) / 100;
    const direction = strOf(params, "direction", "Right");
    if (opacity <= 0.001) {
        return cloneImageData(src);
    }
    const mask = brightMask(src, threshold, Math.min(1, threshold + 0.06));
    const steps = Math.round(clamp(length / 5, 4, 12));
    const stepPx = Math.max(1, env.px(length / steps));
    const dir = direction === "Left" ? -1 : 1;
    const streak = directionalStreak(mask, w, h, dir, 0, steps, stepPx);
    const layer = maskLayer(streak, w, h, [255, 250, 240], 1 / (steps * 1.8));
    return addLayer(src, layer, opacity);
};

const minecraftGrass: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const block = cellOf(env, clamp(num(params, "block_size", 16), 4, 64), 2);
    const grassRows = Math.round(clamp(num(params, "grass_rows", 2), 1, 8));
    const dirtRows = Math.round(clamp(num(params, "dirt_rows", 4), 1, 16));
    const topEdge = boolOf(params, "top_edge", false);
    const overlap = Math.round(clamp(num(params, "overlap", 1), 0, 8));
    const grassColor = rgbOf(params, "grass_color", "#59B030");
    const dirtColor = rgbOf(params, "dirt_color", "#866043");
    const seed = deriveSeed(env.seed, "minecraft-grass");

    const bw = Math.ceil(w / block);
    const bh = Math.ceil(h / block);
    const blockR = new Float32Array(bw * bh);
    const blockG = new Float32Array(bw * bh);
    const blockB = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const cx = Math.min(w - 1, bx * block + (block >> 1));
            const cy = Math.min(h - 1, by * block + (block >> 1));
            const i = (cy * w + cx) * 4;
            blockR[by * bw + bx] = src.data[i];
            blockG[by * bw + bx] = src.data[i + 1];
            blockB[by * bw + bx] = src.data[i + 2];
        }
    }

    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        const by = Math.floor(y / block);
        const v = (y - by * block) / block;
        for (let x = 0; x < w; x++) {
            const bx = Math.floor(x / block);
            const u = (x - bx * block) / block;
            const i = (y * w + x) * 4;
            const p = by * bw + bx;
            const variation = 0.82 + hash01(bx, by, seed) * 0.36;
            let r = blockR[p] * variation;
            let g = blockG[p] * variation;
            let b = blockB[p] * variation;

            const fromTop = topEdge ? by : bh - 1 - by;
            const jag = hash01(bx, 0, seed + 17) > 0.55 ? 1 : 0;
            const grassTop = grassRows;
            const dirtEnd = grassTop + dirtRows;
            const localTop = fromTop;
            if (localTop < dirtEnd + overlap && localTop >= grassTop) {
                r = dirtColor[0];
                g = dirtColor[1];
                b = dirtColor[2];
            } else if (localTop < grassTop + jag) {
                r = grassColor[0];
                g = grassColor[1];
                b = grassColor[2];
            }
            const edgeShade = u < 0.06 || v < 0.06 ? 0.82 : 1;
            d[i] = clamp255(r * edgeShade * variation);
            d[i + 1] = clamp255(g * edgeShade * variation);
            d[i + 2] = clamp255(b * edgeShade * variation);
            d[i + 3] = 255;
        }
    }
    return out;
};

const rustCorrosion: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const corrosion = clamp(num(params, "corrosion", 58), 0, 100);
    const pitting = clamp(num(params, "pitting", 44), 0, 100);
    const streaks = clamp(num(params, "streaks", 36), 0, 100) / 100;
    const dirt = clamp(num(params, "dirt", 26), 0, 100) / 100;
    const edgeWear = clamp(num(params, "edge_wear", 52), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "rust");
    const field = rustField(w, h, Math.max(4, env.px(26)), seed, corrosion, pitting);
    const edges = sobelEdge(src, 2.2, 30);
    const grainSeed = seed + 211;
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            const rustMask = field[p];
            const streakNoise = valueNoise2D(x / 9, y / 120, grainSeed);
            const streak = clamp(streakNoise * 1.4 - 0.55, 0, 1) * streaks;
            const pit = rustMask * (0.55 + 0.45 * hash01(x, y, grainSeed + 7));
            const wear = (edges.data[i] / 255) * edgeWear;
            const rustTone: RGB = [
                86 + 130 * rustMask + streak * 40,
                46 + 82 * rustMask,
                24 + 38 * rustMask,
            ];
            const mixRust = clamp(pit * 1.15 + streak * 0.35, 0, 1);
            const mixDirt = dirt * 0.45;
            for (let c = 0; c < 3; c++) {
                let value = d[i + c];
                value = value * (1 - mixRust) + rustTone[c] * mixRust;
                value = value * (1 - mixDirt) + [96, 72, 52][c] * mixDirt;
                value += wear * 120;
                d[i + c] = clamp255(value);
            }
        }
    }
    return out;
};

const claymationTexture: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const chunkSize = cellOf(env, clamp(num(params, "chunkSize", 8), 3, 18), 2);
    const smoothness = clamp(num(params, "smoothness", 55), 0, 100) / 100;
    const relief = clamp(num(params, "relief", 35), 0, 100) / 100;
    const saturation = clamp(num(params, "saturation", 20), -100, 100) / 100;
    const grainAmount = clamp(num(params, "textureGrain", 30), 0, 100);
    const seed = deriveSeed(env.seed, "clay");
    const rand = mulberry32(seed);

    const bw = Math.ceil(w / chunkSize);
    const bh = Math.ceil(h / chunkSize);
    const cr = new Float32Array(bw * bh);
    const cg = new Float32Array(bw * bh);
    const cb = new Float32Array(bw * bh);
    const cl = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const jx = (rand() - 0.5) * chunkSize * 0.7;
            const jy = (rand() - 0.5) * chunkSize * 0.7;
            const sx = clamp(bx * chunkSize + chunkSize * 0.5 + jx, 0, w - 1);
            const sy = clamp(by * chunkSize + chunkSize * 0.5 + jy, 0, h - 1);
            const o = new Float32Array(4);
            sampleBilinear(src, sx, sy, o);
            const p = by * bw + bx;
            cr[p] = o[0];
            cg[p] = o[1];
            cb[p] = o[2];
            cl[p] = luminance(o[0], o[1], o[2]);
        }
    }

    const softened = gaussianBlur(src, Math.min(8, pxOf(env, 0.5 + smoothness * 7, 0)));
    const out = makeImageData(w, h);
    const d = out.data;
    const lightX = 0.55;
    const lightY = 0.65;
    for (let y = 0; y < h; y++) {
        const by = Math.min(bh - 1, Math.floor(y / chunkSize));
        for (let x = 0; x < w; x++) {
            const bx = Math.min(bw - 1, Math.floor(x / chunkSize));
            const i = (y * w + x) * 4;
            const p = by * bw + bx;
            const leftL = bx > 0 ? cl[p - 1] : cl[p];
            const upL = by > 0 ? cl[p - bw] : cl[p];
            const bevel = ((cl[p] - leftL) * lightX + (cl[p] - upL) * lightY) * relief * 1.8;
            const soft = smoothness * 0.55;
            const r = cr[p] * (1 - soft) + softened.data[i] * soft + bevel;
            const g = cg[p] * (1 - soft) + softened.data[i + 1] * soft + bevel;
            const b = cb[p] * (1 - soft) + softened.data[i + 2] * soft + bevel;
            const hsl: RGB = [r, g, b];
            const [hh, ss, ll] = rgbToHsl(clamp255(r), clamp255(g), clamp255(b));
            hslToRgb(hh, clamp(ss * (1 + saturation), 0, 100), ll, hsl);
            const grain = (hash01(x, y, seed + 33) - 0.5) * grainAmount * 0.9;
            d[i] = clamp255(hsl[0] + grain);
            d[i + 1] = clamp255(hsl[1] + grain);
            d[i + 2] = clamp255(hsl[2] + grain);
            d[i + 3] = src.data[i + 3];
        }
    }
    return out;
};

const fakeHair: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const count = Math.min(100, Math.round(clamp(num(params, "count", 1), 1, 100) * 4));
    const length = env.px(clamp(num(params, "length", 180), 20, 600));
    const thickness = clamp(num(params, "thickness", 1), 0.5, 4);
    const curliness = clamp(num(params, "curliness", 30), 0, 100) / 100;
    const hair = parseColor(strOf(params, "hair_color", "#140F0ADC"));
    const color: RGB = [hair[0], hair[1], hair[2]];
    const alpha = clamp(hair[3] / 255, 0, 1) * 0.9;
    const seed = deriveSeed(env.seed, "fake-hair");
    const rand = mulberry32(seed);

    const field = new Float32Array(w * h);
    const brush = Math.max(0.6, env.px(thickness * 0.8));
    for (let s = 0; s < count; s++) {
        let x = rand() * w;
        let y = -brush - rand() * env.px(10);
        let angle = Math.PI / 2 + (rand() - 0.5) * 0.9;
        const curlFreq = 0.02 + rand() * 0.06;
        const curlPhase = rand() * Math.PI * 2;
        const strandLength = length * (0.55 + rand() * 0.7);
        const steps = Math.min(900, Math.max(8, Math.round(strandLength)));
        const brightness = 0.75 + rand() * 0.5;
        for (let k = 0; k < steps; k++) {
            const t = k / steps;
            angle += (rand() - 0.5) * 0.06 * (0.4 + curliness * 2.2);
            x += Math.cos(angle);
            y += Math.sin(angle) * 0.6 + 0.7;
            if (x < 0 || x >= w || y >= h) {
                break;
            }
            const taper = Math.min(1, t * 6) * (1 - Math.max(0, t - 0.75) * 2.4);
            const sway = Math.sin(k * curlFreq + curlPhase) * curliness * 2.5;
            stampField(field, w, h, x + sway, y, brush, alpha * taper * brightness);
        }
    }
    const layer = maskLayer(field, w, h, color);
    let out = cloneImageData(src);
    const d = out.data;
    const l = layer.data;
    for (let i = 0; i < d.length; i += 4) {
        const a = l[i + 3] / 255;
        if (a <= 0) {
            continue;
        }
        d[i] = clamp255(d[i] * (1 - a) + l[i] * a);
        d[i + 1] = clamp255(d[i + 1] * (1 - a) + l[i + 1] * a);
        d[i + 2] = clamp255(d[i + 2] * (1 - a) + l[i + 2] * a);
        d[i + 3] = clamp255(d[i + 3] + (255 - d[i + 3]) * a);
    }
    out = cloneImageData(out);
    return out;
};

// ---------------------------------------------------------------- composites

const doubleExposure: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const amount = clamp(num(params, "blend_amount", 62), 0, 100) / 100;
    const offsetX = Math.round(env.px(clamp(num(params, "offset_x", 22), -500, 500)));
    const offsetY = Math.round(env.px(clamp(num(params, "offset_y", -14), -500, 500)));
    const ghostBlur = clamp(num(params, "ghost_blur", 8), 0, 30);
    const highlightBias = clamp(num(params, "highlight_bias", 55), 0, 100) / 100;
    const contrast = clamp(num(params, "contrast", 112), 50, 200) / 100;
    if (amount <= 0.001) {
        return cloneImageData(src);
    }
    const shifted = makeImageData(w, h);
    const s = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (sampleBilinear(src, x - offsetX, y - offsetY, s)) {
                const i = (y * w + x) * 4;
                shifted.data[i] = clamp255(s[0]);
                shifted.data[i + 1] = clamp255(s[1]);
                shifted.data[i + 2] = clamp255(s[2]);
                shifted.data[i + 3] = clamp255(s[3]);
            }
        }
    }
    const blurred = gaussianBlur(shifted, Math.min(30, pxOf(env, ghostBlur, 0)));
    const out = cloneImageData(src);
    const d = out.data;
    const b = blurred.data;
    for (let i = 0; i < d.length; i += 4) {
        const lum = luminance(d[i], d[i + 1], d[i + 2]) / 255;
        const wgt = clamp(amount * (0.22 + highlightBias * lum * 1.25), 0, 1);
        for (let c = 0; c < 3; c++) {
            const base = d[i + c] / 255;
            const over = (b[i + c] / 255) * wgt;
            let value = (1 - (1 - base) * (1 - over)) * 255;
            value = (value / 255 - 0.5) * contrast * 255 + 127.5;
            d[i + c] = clamp255(value);
        }
    }
    return out;
};

const ghostTrail: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const copies = Math.round(clamp(num(params, "copies", 3), 1, 8));
    const offsetX = env.px(clamp(num(params, "offset_x", 15), -50, 50));
    const offsetY = env.px(clamp(num(params, "offset_y", 5), -50, 50));
    const fade = clamp(num(params, "fade", 50), 10, 90) / 100;
    const out = cloneImageData(src);
    const d = out.data;
    const s = new Float32Array(4);
    for (let k = copies; k >= 1; k--) {
        const alpha = fade * (1 - (k - 1) / Math.max(1, copies)) * 0.85;
        const dx = Math.round(offsetX * k);
        const dy = Math.round(offsetY * k);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (!sampleBilinear(src, x - dx, y - dy, s) || s[3] <= 0) {
                    continue;
                }
                const i = (y * w + x) * 4;
                const a = alpha * (s[3] / 255);
                d[i] = clamp255(d[i] * (1 - a) + s[0] * a);
                d[i + 1] = clamp255(d[i + 1] * (1 - a) + s[1] * a);
                d[i + 2] = clamp255(d[i + 2] * (1 - a) + s[2] * a);
            }
        }
    }
    return out;
};

/** Seeded ink/blood splatter: irregular blobs plus vertical drips. */
function splatterField(
    w: number,
    h: number,
    amount: number,
    dripLength: number,
    spread: number,
    env: EffectEnv,
    seed: number
): Float32Array {
    const rand = mulberry32(seed);
    const field = new Float32Array(w * h);
    const blobs = Math.max(2, Math.min(28, Math.round(3 + amount * 22)));
    for (let b = 0; b < blobs; b++) {
        const cx = rand() * w;
        const cy = rand() * h;
        const radius = Math.max(1, env.px((0.6 + rand() * 2.4) * spread * 0.35));
        stampField(field, w, h, cx, cy, radius, 0.9);
        stampField(field, w, h, cx + radius * 0.7, cy - radius * 0.4, radius * 0.7, 0.8);
        stampField(field, w, h, cx - radius * 0.6, cy + radius * 0.35, radius * 0.6, 0.8);
        const satellites = 2 + Math.round(rand() * 4);
        for (let s = 0; s < satellites; s++) {
            const ang = rand() * Math.PI * 2;
            const dist = radius * (1.4 + rand() * 1.8);
            stampField(
                field,
                w,
                h,
                cx + Math.cos(ang) * dist,
                cy + Math.sin(ang) * dist,
                Math.max(0.6, radius * (0.12 + rand() * 0.2)),
                0.85
            );
        }
        if (rand() < 0.75 && dripLength > 0.01) {
            const dripCount = 1 + Math.round(rand() * 2);
            for (let dr = 0; dr < dripCount; dr++) {
                const dx = cx + (rand() - 0.5) * radius * 1.4;
                const len = env.px((0.35 + rand() * 0.9) * dripLength * 2.2);
                const steps = Math.max(2, Math.round(len));
                const width = Math.max(0.6, radius * (0.12 + rand() * 0.1));
                for (let k = 0; k < steps; k++) {
                    const t = k / steps;
                    stampField(field, w, h, dx + Math.sin(k * 0.12) * width * 0.4, cy + k, width * (1 - t * 0.55), 0.9 * (1 - t * 0.6));
                }
            }
        }
    }
    return field;
}

const inkSplatterDrips: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const amount = clamp(num(params, "ink_amount", 55), 0, 100) / 100;
    const dripLength = clamp(num(params, "drip_length", 45), 0, 100) / 100;
    const spread = clamp(num(params, "spread", 35), 0, 100);
    const paperFade = clamp(num(params, "paper_fade", 20), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "ink");
    const field = splatterField(w, h, amount, dripLength, spread, env, seed);
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            const wash = paperFade * 0.55;
            const inkA = clamp(field[p] * 0.9, 0, 1);
            const baseR = d[i] * (1 - wash) + 246 * wash;
            const baseG = d[i + 1] * (1 - wash) + 243 * wash;
            const baseB = d[i + 2] * (1 - wash) + 234 * wash;
            const ink = 12 + clamp(1 - field[p], 0, 1) * 16;
            d[i] = clamp255(baseR * (1 - inkA) + ink * inkA);
            d[i + 1] = clamp255(baseG * (1 - inkA) + ink * inkA);
            d[i + 2] = clamp255(baseB * (1 - inkA) + ink * inkA);
        }
    }
    return out;
};

const bloodSplash: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const amount = clamp(num(params, "splash_amount", 52), 0, 100) / 100;
    const dripLength = clamp(num(params, "drip_length", 48), 0, 100) / 100;
    const spread = clamp(num(params, "spread", 42), 0, 100);
    const darkness = clamp(num(params, "darkness", 58), 0, 100) / 100;
    const wetShine = clamp(num(params, "wet_shine", 30), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "blood");
    const field = splatterField(w, h, amount, dripLength, spread, env, seed);
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            const a = clamp(field[p], 0, 1);
            if (a <= 0.001) {
                continue;
            }
            const core = 1 - darkness * 0.7;
            const bloodR = 96 * core + 70 * (1 - a);
            const bloodG = 12 * core + 10 * (1 - a);
            const bloodB = 14 * core + 8 * (1 - a);
            // wet specular streak on the upper-left of each blob
            const shine = wetShine * Math.pow(a, 2.5) * 150;
            d[i] = clamp255(d[i] * (1 - a * 0.94) + bloodR + shine);
            d[i + 1] = clamp255(d[i + 1] * (1 - a * 0.94) + bloodG + shine * 0.85);
            d[i + 2] = clamp255(d[i + 2] * (1 - a * 0.94) + bloodB + shine * 0.85);
        }
    }
    return out;
};

const stripeOverlay: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const widthPx = Math.max(1, env.px(clamp(num(params, "width", 10), 2, 50)));
    const gapPx = Math.max(1, env.px(clamp(num(params, "gap", 10), 2, 50)));
    const angle = (clamp(num(params, "angle", 45), 0, 180) * Math.PI) / 180;
    const opacity = clamp(num(params, "opacity", 40), 0, 100) / 100;
    const color = rgbOf(params, "color", "#000000");
    if (opacity <= 0.001) {
        return cloneImageData(src);
    }
    const period = widthPx + gapPx;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = ((x * cos + y * sin) % period + period) % period;
            if (v >= widthPx) {
                continue;
            }
            const i = (y * w + x) * 4;
            const a = opacity;
            d[i] = clamp255(d[i] * (1 - a) + color[0] * a);
            d[i + 1] = clamp255(d[i + 1] * (1 - a) + color[1] * a);
            d[i + 2] = clamp255(d[i + 2] * (1 - a) + color[2] * a);
        }
    }
    return out;
};

const softDiffusion: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const amount = clamp(num(params, "amount", 52), 0, 100) / 100;
    const radius = Math.min(30, pxOf(env, clamp(num(params, "radius", 12), 0, 30), 0));
    const bloom = clamp(num(params, "highlight_bloom", 40), 0, 100) / 100;
    const soften = clamp(num(params, "contrast_softening", 28), 0, 100) / 100;
    const warmth = clamp(num(params, "warmth", 22), 0, 100) / 100;
    const blurred = gaussianBlur(src, radius);
    let out = screenLayer(src, blurred, amount * 0.55);
    if (bloom > 0.001) {
        const mask = brightMask(src, 0.55, 0.95);
        const pass = maskLayer(mask, w, h, [255, 246, 232]);
        const halo = gaussianBlur(pass, Math.max(1, radius * 1.6));
        out = screenLayer(out, halo, bloom * 0.55);
    }
    const d = out.data;
    const b = blurred.data;
    const soft = soften * 0.3;
    for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp255((d[i] * (1 - soft) + b[i] * soft) * (1 + warmth * 0.06));
        d[i + 1] = clamp255(d[i + 1] * (1 - soft) + b[i + 1] * soft);
        d[i + 2] = clamp255((d[i + 2] * (1 - soft) + b[i + 2] * soft) * (1 - warmth * 0.05));
    }
    return out;
};

// -------------------------------------------------------------- frame & tone

const reflection: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const percentage = clamp(num(params, "percentage", 20), 1, 100);
    const maxAlpha = clamp(num(params, "max_alpha", 255), 0, 255);
    const minAlpha = clamp(num(params, "min_alpha", 0), 0, 255);
    const offset = clamp(num(params, "offset", 0), 0, 100);
    const skew = boolOf(params, "skew", false);
    const skewSize = clamp(num(params, "skew_size", 25), 1, 100);

    const reflH = Math.max(1, Math.min(h, Math.round((h * percentage) / 100)));
    const gap = Math.max(0, Math.round(env.px(offset)));
    const skewPx = skew ? Math.round((reflH * skewSize) / 100) : 0;
    const pad: Insets = { top: 0, right: skewPx, bottom: reflH + gap, left: 0 };
    const expanded = withFrame(src, pad);
    const ew = expanded.width;
    const eh = expanded.height;
    const ed = expanded.data;
    const sd = src.data;
    const startY = h + gap;
    for (let r = 0; r < reflH; r++) {
        const srcY = h - 1 - r;
        if (srcY < 0 || startY + r >= eh) {
            break;
        }
        const t = reflH <= 1 ? 0 : r / (reflH - 1);
        const alpha = (maxAlpha + (minAlpha - maxAlpha) * t) / 255;
        const xShift = skew ? Math.round((r * skewSize) / 100) : 0;
        const y = startY + r;
        for (let x = 0; x < w; x++) {
            const si = (srcY * w + x) * 4;
            const sa = (sd[si + 3] / 255) * alpha;
            if (sa <= 0.002) {
                continue;
            }
            const dx = x + xShift;
            if (dx >= ew) {
                continue;
            }
            const di = (y * ew + dx) * 4;
            const inv = 1 - sa;
            ed[di] = clamp255(sd[si] * sa + ed[di] * inv);
            ed[di + 1] = clamp255(sd[si + 1] * sa + ed[di + 1] * inv);
            ed[di + 2] = clamp255(sd[si + 2] * sa + ed[di + 2] * inv);
            ed[di + 3] = clamp255(sa * 255 + ed[di + 3] * inv);
        }
    }
    return { data: expanded, pad };
};

const nebulaStarfield: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const intensity = clamp(num(params, "intensity", 70), 0, 100) / 100;
    const scale = clamp(num(params, "scale", 80), 0, 100);
    const hueShift = clamp(num(params, "hue_shift", -15), -180, 180);
    const starDensity = clamp(num(params, "star_density", 55), 0, 100) / 100;
    const starSize = clamp(num(params, "star_size", 10), 0, 200);
    const twinkle = clamp(num(params, "twinkle", 40), 0, 100) / 100;
    const vignette = clamp(num(params, "vignette_strength", 18), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "nebula");
    const rand = mulberry32(seed);

    const wave = Math.max(6, Math.min(w, h) / (1.4 + scale * 0.05));
    const cell = coarseCell(w, h);
    const gas = coarseField(w, h, cell, (x, y) => {
        const n = fbm(x / wave, y / wave, 5, 0.58, 2.1, seed);
        const warp = fbm(x / wave + n * 2.6, y / wave - n * 2.2, 4, 0.55, 2, seed + 43);
        const band = 0.5 + 0.5 * Math.sin((x / w) * 4 + (y / h) * 3 + n * 5);
        return clamp(warp * 0.72 + n * 0.28 + band * 0.12, 0, 1);
    });

    const out = cloneImageData(src);
    const d = out.data;
    const color: RGB = [0, 0, 0];
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const maxR = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            const n = gas[p];
            const hue = hueShift + n * 210 + (y / h) * 45;
            hslToRgb(hue, 78, 22 + n * 34, color);
            const a = intensity * clamp(n * 1.25 - 0.18, 0, 1);
            const vig = 1 - vignette * Math.pow(Math.hypot(x - cx, y - cy) / (maxR || 1), 2.2);
            for (let c = 0; c < 3; c++) {
                d[i + c] = clamp255((d[i + c] * (1 - a) + color[c] * a) * vig);
            }
        }
    }

    const stars = new Float32Array(w * h);
    const count = Math.min(320, Math.round(4 + starDensity * 316));
    const maxStar = env.px(0.4 + starSize * 0.018);
    for (let s = 0; s < count; s++) {
        const sx = rand() * w;
        const sy = rand() * h;
        const radius = Math.max(0.5, maxStar * (0.4 + rand() * 1.1));
        const brightness = 0.45 + rand() * 0.55;
        stampField(stars, w, h, sx, sy, radius, brightness);
        if (twinkle > 0.001 && rand() < 0.18) {
            const flare = radius * (2.2 + twinkle * 4);
            stampField(stars, w, h, sx, sy, flare, brightness * twinkle * 0.16);
        }
    }
    const starLayer = maskLayer(stars, w, h, [235, 242, 255]);
    return screenLayer(out, starLayer, 0.95);
};

const shadow: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const opacity = clamp(num(params, "opacity", 80), 0, 100) / 100;
    const size = clamp(num(params, "size", 20), 0, 100);
    const ox = Math.round(env.px(clamp(num(params, "offset_x", 5), -1000, 1000)));
    const oy = Math.round(env.px(clamp(num(params, "offset_y", 5), -1000, 1000)));
    const color = rgbOf(params, "color", "#000000");
    const autoResize = boolOf(params, "auto_resize", true);
    const blurPx = Math.max(0, Math.round(env.px(size * 0.5)));

    const pad: Insets = autoResize
        ? {
              top: Math.max(0, -oy) + blurPx,
              right: Math.max(0, ox) + blurPx,
              bottom: Math.max(0, oy) + blurPx,
              left: Math.max(0, -ox) + blurPx,
          }
        : { top: 0, right: 0, bottom: 0, left: 0 };
    const expanded = withFrame(src, pad);
    const ew = expanded.width;
    const eh = expanded.height;
    const ed = expanded.data;
    const sd = src.data;

    const alphaField = new Float32Array(w * h);
    for (let i = 3, p = 0; p < alphaField.length; i += 4, p++) {
        alphaField[p] = sd[i] / 255;
    }
    const blurred = blurField(alphaField, w, h, Math.min(120, blurPx));
    const left = pad.left;
    const top = pad.top;

    for (let y = 0; y < h; y++) {
        const dy = top + y + oy;
        if (dy < 0 || dy >= eh) {
            continue;
        }
        for (let x = 0; x < w; x++) {
            const a = clamp(blurred[y * w + x] * opacity, 0, 1);
            if (a <= 0.002) {
                continue;
            }
            const dx = left + x + ox;
            if (dx < 0 || dx >= ew) {
                continue;
            }
            const di = (dy * ew + dx) * 4;
            ed[di] = color[0];
            ed[di + 1] = color[1];
            ed[di + 2] = color[2];
            ed[di + 3] = clamp255(a * 255 + ed[di + 3] * (1 - a));
        }
    }

    for (let y = 0; y < h; y++) {
        const dy = top + y;
        if (dy >= eh) {
            break;
        }
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            const sa = sd[si + 3] / 255;
            if (sa <= 0) {
                continue;
            }
            const di = (dy * ew + left + x) * 4;
            const inv = 1 - sa;
            ed[di] = clamp255(sd[si] * sa + ed[di] * inv);
            ed[di + 1] = clamp255(sd[si + 1] * sa + ed[di + 1] * inv);
            ed[di + 2] = clamp255(sd[si + 2] * sa + ed[di + 2] * inv);
            ed[di + 3] = clamp255(sa * 255 + ed[di + 3] * inv);
        }
    }
    return { data: expanded, pad };
};

const miniature: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const radius = Math.min(40, pxOf(env, clamp(num(params, "blur_radius", 15), 2, 40)));
    const focusPosition = clamp(num(params, "focus_position", 50), 10, 90) / 100;
    const focusBand = clamp(num(params, "focus_band", 20), 5, 50) / 100;
    const saturation = clamp(num(params, "saturation", 20), 0, 50) / 100;
    const blurred = gaussianBlur(src, radius);
    const out = makeImageData(w, h);
    const d = out.data;
    const b = blurred.data;
    const s = src.data;
    const focusY = focusPosition * (h - 1);
    const band = Math.max(1, focusBand * h * 0.5);
    const color: RGB = [0, 0, 0];
    for (let y = 0; y < h; y++) {
        const weight = smoothstep(band * 0.55, band * 1.8, Math.abs(y - focusY));
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const mixR = s[i] * (1 - weight) + b[i] * weight;
            const mixG = s[i + 1] * (1 - weight) + b[i + 1] * weight;
            const mixB = s[i + 2] * (1 - weight) + b[i + 2] * weight;
            const [hh, ss, ll] = rgbToHsl(clamp255(mixR), clamp255(mixG), clamp255(mixB));
            hslToRgb(hh, clamp(ss * (1 + saturation * 0.9), 0, 100), ll, color);
            d[i] = clamp255(color[0]);
            d[i + 1] = clamp255(color[1]);
            d[i + 2] = clamp255(color[2]);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const perlinNoise: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const scale = Math.max(1, env.px(clamp(num(params, "scale", 64), 1, 500)));
    const octaves = Math.round(clamp(num(params, "octaves", 4), 1, 8));
    const persistence = clamp(num(params, "persistence", 0.5), 0, 1);
    const strength = clamp(num(params, "strength", 50), 0, 100) / 100;
    const monochrome = boolOf(params, "monochrome", true);
    if (strength <= 0.001) {
        return cloneImageData(src);
    }
    const seed = deriveSeed(env.seed, "perlin");
    const out = cloneImageData(src);
    const d = out.data;
    const amp = strength * 170;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (monochrome) {
                const delta = (fbm(x / scale, y / scale, octaves, persistence, 2, seed) - 0.5) * amp;
                d[i] = clamp255(d[i] + delta);
                d[i + 1] = clamp255(d[i + 1] + delta);
                d[i + 2] = clamp255(d[i + 2] + delta);
            } else {
                const nr = (fbm(x / scale, y / scale, octaves, persistence, 2, seed + 11) - 0.5) * amp;
                const ng = (fbm(x / scale, y / scale, octaves, persistence, 2, seed + 29) - 0.5) * amp;
                const nb = (fbm(x / scale, y / scale, octaves, persistence, 2, seed + 53) - 0.5) * amp;
                d[i] = clamp255(d[i] + nr);
                d[i + 1] = clamp255(d[i + 1] + ng);
                d[i + 2] = clamp255(d[i + 2] + nb);
            }
        }
    }
    return out;
};

const radialRainbow: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const strength = clamp(num(params, "strength", 50), 0, 100) / 100;
    const rotations = Math.round(clamp(num(params, "rotations", 1), 1, 5));
    if (strength <= 0.001) {
        return cloneImageData(src);
    }
    const out = cloneImageData(src);
    const d = out.data;
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const color: RGB = [0, 0, 0];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const angle = Math.atan2(y - cy, x - cx);
            const turn = (angle + Math.PI) / (Math.PI * 2);
            const degrees = turn * 360 * rotations * strength;
            shiftHuePixel(d[i], d[i + 1], d[i + 2], degrees, color);
            const rainbow = turn * 360 * rotations * 0.05;
            const [rh, , rl] = rgbToHsl(clamp255(color[0]), clamp255(color[1]), clamp255(color[2]));
            hslToRgb(rh + rainbow, 62, rl, color);
            d[i] = clamp255(color[0]);
            d[i + 1] = clamp255(color[1]);
            d[i + 2] = clamp255(color[2]);
        }
    }
    return out;
};

const filmGrain: EffectImpl = (src, params, env) => {
    const amount = clamp(num(params, "amount", 30), 1, 100);
    const monochrome = boolOf(params, "monochrome", true);
    const seed = deriveSeed(env.seed, "film-grain");
    const out = cloneImageData(src);
    const d = out.data;
    const w = src.width;
    const amp = amount * 1.5;
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (monochrome) {
                const n = (hash01(x, y, seed) - 0.5) * amp;
                d[i] = clamp255(d[i] + n);
                d[i + 1] = clamp255(d[i + 1] + n);
                d[i + 2] = clamp255(d[i + 2] + n);
            } else {
                d[i] = clamp255(d[i] + (hash01(x, y, seed) - 0.5) * amp);
                d[i + 1] = clamp255(d[i + 1] + (hash01(x, y, seed + 71) - 0.5) * amp);
                d[i + 2] = clamp255(d[i + 2] + (hash01(x, y, seed + 131) - 0.5) * amp);
            }
        }
    }
    return out;
};

const innerShadow: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const opacity = clamp(num(params, "opacity", 70), 0, 100) / 100;
    const size = clamp(num(params, "size", 20), 0, 300);
    const color = rgbOf(params, "color", "#000000");
    const offsetX = Math.round(env.px(clamp(num(params, "offset_x", 0), -300, 300)));
    const offsetY = Math.round(env.px(clamp(num(params, "offset_y", 0), -300, 300)));
    if (opacity <= 0.001) {
        return cloneImageData(src);
    }
    const alphaField = new Float32Array(w * h);
    for (let i = 3, p = 0; p < alphaField.length; i += 4, p++) {
        alphaField[p] = src.data[i] / 255;
    }
    const blurPx = Math.max(1, Math.min(150, Math.round(env.px(size * 0.5))));
    const blurred = blurField(alphaField, w, h, blurPx);
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        const sy = y - offsetY;
        for (let x = 0; x < w; x++) {
            const sx = x - offsetX;
            if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
                continue;
            }
            const i = (y * w + x) * 4;
            const coverage = clamp(alphaField[y * w + x] * (1 - blurred[sy * w + sx]), 0, 1);
            const a = coverage * opacity;
            if (a <= 0.002) {
                continue;
            }
            d[i] = clamp255(d[i] * (1 - a) + color[0] * a);
            d[i + 1] = clamp255(d[i + 1] * (1 - a) + color[1] * a);
            d[i + 2] = clamp255(d[i + 2] * (1 - a) + color[2] * a);
        }
    }
    return out;
};

// ------------------------------------------------------------------ registry

export const FILTER_F3_IMPLS: EffectRegistry = {
    anamorphic_lens_flare: anamorphicLensFlare,
    bloom,
    dream_glow: dreamGlow,
    glare,
    glow,
    halation,
    light_leak: lightLeak,
    star_filter: starFilter,
    neon_edge_glow: neonEdgeGlow,
    plasma_energy_arcs: plasmaEnergyArcs,
    etched_glass: etchedGlass,
    frosted_glass: frostedGlass,
    frosted_glass_ice_edges: frostedGlassIceEdges,
    liquid_glass: liquidGlass,
    liquid_mercury: liquidMercury,
    crystal_prism: crystalPrism,
    crystalize_shards: crystalizeShards,
    oil_slick_interference: oilSlickInterference,
    holographic_foil_shimmer: holographicFoilShimmer,
    clouds,
    rainy_window: rainyWindow,
    snowfall_depth_fog: snowfallDepthFog,
    smoke_overlay: smokeOverlay,
    heat_haze_refraction: heatHazeRefraction,
    wind_streaks: windStreaks,
    minecraft_grass: minecraftGrass,
    rust_corrosion: rustCorrosion,
    claymation_texture: claymationTexture,
    fake_hair: fakeHair,
    double_exposure: doubleExposure,
    ghost_trail: ghostTrail,
    ink_splatter_drips: inkSplatterDrips,
    blood_splash: bloodSplash,
    stripe_overlay: stripeOverlay,
    soft_diffusion: softDiffusion,
    reflection,
    nebula_starfield: nebulaStarfield,
    shadow,
    miniature,
    perlin_noise: perlinNoise,
    radial_rainbow: radialRainbow,
    film_grain: filmGrain,
    inner_shadow: innerShadow,
};

export const FILTER_F3_FRAME_IDS: string[] = ["reflection", "shadow"];


