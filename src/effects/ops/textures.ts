/**
 * Procedural texture generators. Pure noise helpers return Float32Array fields
 * in 0..1; textureImageData paints a field into RGBA, and paintTexture is the
 * browser-only convenience used by frame painters.
 */
import { clamp, makeImageData, parseColor } from "../pixels.ts";
import type { ParamDict } from "../types.ts";

const GRADS: number[] = [
    1, 0, -1, 0, 0, 1, 0, -1,
    0.70710678, 0.70710678, -0.70710678, 0.70710678,
    0.70710678, -0.70710678, -0.70710678, -0.70710678,
    0.92387953, 0.38268343, -0.92387953, 0.38268343,
    0.38268343, 0.92387953, -0.38268343, 0.92387953,
    0.92387953, -0.38268343, -0.92387953, -0.38268343,
    0.38268343, -0.92387953, -0.38268343, -0.92387953,
];

function hash2(ix: number, iy: number, seed: number): number {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/** Seeded value noise in 0..1 for smooth 2D interpolation. */
export function valueNoise2D(x: number, y: number, seed = 1): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const v00 = hash2(x0, y0, seed);
    const v10 = hash2(x0 + 1, y0, seed);
    const v01 = hash2(x0, y0 + 1, seed);
    const v11 = hash2(x0 + 1, y0 + 1, seed);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
}

function gradDot(ix: number, iy: number, dx: number, dy: number, seed: number): number {
    const g = (hash2(ix, iy, seed) * 8) | 0;
    return GRADS[g * 2] * dx + GRADS[g * 2 + 1] * dy;
}

/** Classic Perlin noise in roughly -1..1. */
export function perlin2(x: number, y: number, seed = 1): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const dx = x - x0;
    const dy = y - y0;
    const fx = smooth(dx);
    const fy = smooth(dy);
    const n00 = gradDot(x0, y0, dx, dy, seed);
    const n10 = gradDot(x0 + 1, y0, dx - 1, dy, seed);
    const n01 = gradDot(x0, y0 + 1, dx, dy - 1, seed);
    const n11 = gradDot(x0 + 1, y0 + 1, dx - 1, dy - 1, seed);
    const a = n00 + (n10 - n00) * fx;
    const b = n01 + (n11 - n01) * fx;
    return (a + (b - a) * fy) * 1.4;
}

/** Fractal brownian motion mapped to 0..1. */
export function fbm(
    x: number,
    y: number,
    octaves = 4,
    persistence = 0.5,
    lacunarity = 2,
    seed = 1
): number {
    const count = Math.max(1, Math.round(octaves));
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
        sum += perlin2(x * freq, y * freq, seed + i * 131) * amp;
        total += amp;
        amp *= persistence;
        freq *= lacunarity;
    }
    return clamp(0.5 + 0.5 * (sum / (total || 1)), 0, 1);
}

/** Samples fbm over a width × height grid at a given feature scale. */
export function noiseField(
    width: number,
    height: number,
    scale = 64,
    seed = 1,
    octaves = 1,
    persistence = 0.5
): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(1, scale);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            out[y * w + x] = fbm(x / s, y / s, octaves, persistence, 2, seed);
        }
    }
    return out;
}

/** Soft cloud coverage mask in 0..1. */
export function cloudField(
    width: number,
    height: number,
    scale: number,
    seed: number,
    coverage: number,
    softness: number
): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(2, scale);
    const lo = (coverage - softness * 0.5) / 100;
    const hi = (coverage + softness * 0.5) / 100;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const n = fbm(x / s, y / s, 5, 0.55, 2, seed);
            const t = clamp((n - lo) / (hi - lo || 1), 0, 1);
            out[y * w + x] = smooth(t);
        }
    }
    return out;
}

/** Concentric wood grain, 0..1 (1 = grain line). */
export function woodGrainField(width: number, height: number, scale: number, seed: number): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(4, scale);
    const cx = w / 2;
    const cy = h / 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = (y - cy) * 0.28;
            const r = Math.sqrt(dx * dx + dy * dy) / s;
            const warp = fbm(x / s, y / (s * 0.4), 3, 0.5, 2, seed) * 1.8;
            const band = 0.5 + 0.5 * Math.sin(r * 9 + warp * 4);
            out[y * w + x] = Math.pow(band, 1.8);
        }
    }
    return out;
}

/** Marble veins in 0..1 (1 = vein). */
export function marbleVeinField(
    width: number,
    height: number,
    scale: number,
    seed: number,
    strength = 60
): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(4, scale);
    const k = clamp(strength, 0, 100) / 100;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const n = fbm(x / s, y / s, 5, 0.6, 2.1, seed);
            const v = Math.abs(Math.sin((x / s) * 0.35 + y / (s * 2) + n * 7));
            out[y * w + x] = Math.pow(1 - v, 8) * k;
        }
    }
    return out;
}

/** Rust / corrosion mask in 0..1. */
export function rustField(
    width: number,
    height: number,
    scale: number,
    seed: number,
    corrosion = 58,
    pitting = 44
): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(2, scale);
    const threshold = 1 - clamp(corrosion, 0, 100) / 100;
    const pits = clamp(pitting, 0, 100) / 100;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const n = fbm(x / s, y / s, 5, 0.6, 2, seed);
            const pit = valueNoise2D(x / 3.5, y / 3.5, seed + 41);
            const v = clamp((n - threshold) / (1 - threshold || 0.001), 0, 1);
            out[y * w + x] = clamp(v * (1 - pits * 0.55) + (pit > 0.82 ? 0.55 : 0), 0, 1);
        }
    }
    return out;
}

/** Smoke plume mask in 0..1 with domain warping. */
export function smokeField(width: number, height: number, scale: number, seed: number): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(4, scale);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const warpX = fbm(x / s, y / s, 3, 0.5, 2, seed + 11) * 2;
            const warpY = fbm(x / s + 5, y / s, 3, 0.5, 2, seed + 23) * 2;
            const n = fbm(x / s + warpX, y / s + warpY, 5, 0.55, 2, seed);
            out[y * w + x] = smooth(clamp((n - 0.35) / 0.5, 0, 1));
        }
    }
    return out;
}

/** Ice / frost crystals in 0..1. */
export function frostField(width: number, height: number, scale: number, seed: number): Float32Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = new Float32Array(w * h);
    const s = Math.max(3, scale);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const n = fbm(x / s, y / s, 4, 0.55, 2.3, seed);
            const crystal = Math.abs(Math.sin((x + y) / s * 6 + n * 9));
            out[y * w + x] = clamp(0.25 + n * 0.5 + Math.pow(1 - crystal, 12) * 0.6, 0, 1);
        }
    }
    return out;
}

/** Texture families supported by textureImageData / paintTexture. */
export type TextureKind = "cloud" | "wood" | "marble" | "rust" | "smoke" | "frost";

function numParam(params: ParamDict, key: string, fallback: number): number {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function colorParam(params: ParamDict, key: string, fallback: string): string {
    const value = params[key];
    return typeof value === "string" ? value : fallback;
}

/** Renders a procedural texture into a new RGBA buffer. */
export function textureImageData(
    width: number,
    height: number,
    kind: TextureKind,
    params: ParamDict = {},
    seed = 1
): ImageData {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const out = makeImageData(w, h);
    const d = out.data;
    const scale = Math.max(2, numParam(params, "scale", 64));
    const n = w * h;
    if (kind === "cloud") {
        const field = cloudField(w, h, scale, seed, numParam(params, "coverage", 55), numParam(params, "softness", 64));
        for (let i = 0; i < n; i++) {
            const v = field[i];
            d[i * 4] = 255;
            d[i * 4 + 1] = 255;
            d[i * 4 + 2] = 255;
            d[i * 4 + 3] = v * 210;
        }
    } else if (kind === "wood") {
        const field = woodGrainField(w, h, scale, seed);
        const [r, g, b] = parseColor(colorParam(params, "wood_color", "#8B5E3C"));
        const strength = numParam(params, "grain_strength", 60) / 100;
        for (let i = 0; i < n; i++) {
            const v = field[i];
            const shade = 0.55 + 0.45 * v;
            d[i * 4] = r * shade;
            d[i * 4 + 1] = g * shade;
            d[i * 4 + 2] = b * shade;
            d[i * 4 + 3] = 190 + strength * 65;
        }
    } else if (kind === "marble") {
        const field = marbleVeinField(w, h, scale, seed, numParam(params, "vein_strength", 60));
        const [br, bg, bb] = parseColor(colorParam(params, "base_color", "#EBE6DC"));
        const [vr, vg, vb] = parseColor(colorParam(params, "vein_color", "#5A5046"));
        for (let i = 0; i < n; i++) {
            const v = clamp(field[i] * 1.4, 0, 1);
            d[i * 4] = br + (vr - br) * v;
            d[i * 4 + 1] = bg + (vg - bg) * v;
            d[i * 4 + 2] = bb + (vb - bb) * v;
            d[i * 4 + 3] = 255;
        }
    } else if (kind === "rust") {
        const field = rustField(
            w, h, scale, seed,
            numParam(params, "corrosion", 58),
            numParam(params, "pitting", 44)
        );
        const base = parseColor(colorParam(params, "rock_color", "#5A3A22"));
        const spot = parseColor(colorParam(params, "lava_color", "#C8641E"));
        for (let i = 0; i < n; i++) {
            const v = field[i];
            d[i * 4] = base[0] + (spot[0] - base[0]) * v;
            d[i * 4 + 1] = base[1] + (spot[1] - base[1]) * v;
            d[i * 4 + 2] = base[2] + (spot[2] - base[2]) * v;
            d[i * 4 + 3] = 255;
        }
    } else if (kind === "smoke") {
        const field = smokeField(w, h, scale, seed);
        const [sr, sg, sb] = parseColor(colorParam(params, "color", "#B8B8C0"));
        for (let i = 0; i < n; i++) {
            const v = field[i];
            d[i * 4] = sr;
            d[i * 4 + 1] = sg;
            d[i * 4 + 2] = sb;
            d[i * 4 + 3] = v * 200;
        }
    } else {
        const field = frostField(w, h, scale, seed);
        const [ir, ig, ib] = parseColor(colorParam(params, "ice_color", "#C8E1FF"));
        for (let i = 0; i < n; i++) {
            const v = field[i];
            d[i * 4] = ir;
            d[i * 4 + 1] = ig;
            d[i * 4 + 2] = ib;
            d[i * 4 + 3] = 110 + v * 145;
        }
    }
    return out;
}

/** Browser-only: paints a texture into a rect honouring the current clip. */
export function paintTexture(
    ctx: CanvasRenderingContext2D,
    kind: TextureKind,
    rect: { x: number; y: number; w: number; h: number },
    params: ParamDict = {},
    seed = 1
): void {
    if (typeof document === "undefined" || rect.w <= 0 || rect.h <= 0) {
        return;
    }
    const tex = textureImageData(rect.w, rect.h, kind, params, seed);
    const canvas = document.createElement("canvas");
    canvas.width = tex.width;
    canvas.height = tex.height;
    const cctx = canvas.getContext("2d");
    if (!cctx) {
        return;
    }
    cctx.putImageData(tex, 0, 0);
    ctx.drawImage(canvas, rect.x, rect.y);
}
