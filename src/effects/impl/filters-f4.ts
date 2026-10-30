/**
 * F4 filter effects — artistic, print, glitch and retro media batch (31 ids).
 *
 * Ports ShareX.ImageEditor `Filters/*` onto the shared ops library. Spatial
 * parameters (cell size, tile size, block size, spacing, radius…) are scaled
 * with `env.px()`; 0..100 amounts are not scaled. All noise-driven effects are
 * deterministic from `env.seed`, so previews and exports match.
 */
import { clamp, cloneImageData, makeImageData, parseColor, smoothstep } from "../pixels.ts";
import { deriveSeed, mulberry32 } from "../rand.ts";
import type { EffectImpl, EffectRegistry, ParamDict } from "../types.ts";
import {
    asciiGrid,
    crosshatch,
    engraving,
    fbm,
    gaussianBlur,
    kuwahara,
    oilPaint,
    pixelSort,
    sampleBilinear,
} from "../ops/index.ts";

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

function pxCell(env: { px(value: number): number }, value: number, min = 1): number {
    return Math.max(min, Math.round(env.px(value)));
}

// --------------------------------------------------------------- pixel utils

function hash01(x: number, y: number, seed: number): number {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function byte(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lum01(r: number, g: number, b: number): number {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function screen(a: number, b: number): number {
    return 1 - (1 - clamp01(a)) * (1 - clamp01(b));
}

function avgCell(src: ImageData, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const w = src.width;
    const s = src.data;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            r += s[i];
            g += s[i + 1];
            b += s[i + 2];
            a += s[i + 3];
            n++;
        }
    }
    if (n === 0) {
        return [0, 0, 0, 0];
    }
    return [r / n, g / n, b / n, a / n];
}

/** Luminance buffer (0..1) for kernels that need scalar input. */
function luminanceBuffer(src: ImageData): Float32Array {
    const n = src.width * src.height;
    const out = new Float32Array(n);
    const s = src.data;
    for (let i = 0; i < n; i++) {
        out[i] = lum01(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]);
    }
    return out;
}

/** Packs float RGB (0..1) back into image data. */
function packRgb(out: ImageData, index: number, r: number, g: number, b: number, a: number): void {
    out.data[index] = byte(r * 255);
    out.data[index + 1] = byte(g * 255);
    out.data[index + 2] = byte(b * 255);
    out.data[index + 3] = byte(a);
}

function saturate(r: number, g: number, b: number, amount01: number): [number, number, number] {
    const gray = (r + g + b) / 3;
    const f = 1 + amount01;
    return [gray + (r - gray) * f, gray + (g - gray) * f, gray + (b - gray) * f];
}

function smoothBoxBlur(values: Float32Array, w: number, h: number, radius: number): Float32Array {
    const r = Math.max(1, Math.round(radius));
    const horizontal = new Float32Array(values.length);
    const out = new Float32Array(values.length);
    const window = r * 2 + 1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let acc = 0;
        for (let k = -r; k <= r; k++) {
            acc += values[row + clamp(k, 0, w - 1)];
        }
        for (let x = 0; x < w; x++) {
            horizontal[row + x] = acc / window;
            acc += values[row + clamp(x + r + 1, 0, w - 1)] - values[row + clamp(x - r, 0, w - 1)];
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) {
            acc += horizontal[clamp(k, 0, h - 1) * w + x];
        }
        for (let y = 0; y < h; y++) {
            out[y * w + x] = acc / window;
            acc += horizontal[clamp(y + r + 1, 0, h - 1) * w + x] - horizontal[clamp(y - r, 0, h - 1) * w + x];
        }
    }
    return out;
}

function sobelBuffer(gray: Float32Array, w: number, h: number): Float32Array {
    const out = new Float32Array(gray.length);
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 1);
        const y2 = Math.min(h - 1, y + 1);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - 1);
            const x2 = Math.min(w - 1, x + 1);
            const tl = gray[y0 * w + x0];
            const tc = gray[y0 * w + x];
            const tr = gray[y0 * w + x2];
            const ml = gray[y * w + x0];
            const mr = gray[y * w + x2];
            const bl = gray[y2 * w + x0];
            const bc = gray[y2 * w + x];
            const br = gray[y2 * w + x2];
            const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
            const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
            out[y * w + x] = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 4);
        }
    }
    return out;
}

// ---------------------------------------------------------------- ascii / art

const asciiArt: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const cell = pxCell(env, num(params, "cell_size", 8), 2);
    const contrast = num(params, "contrast", 110) / 100;
    const charsetRaw = strOf(params, "character_set", "@%#*+=-:. ");
    const seen = new Set<string>();
    const chars: string[] = [];
    for (const ch of Array.from(charsetRaw)) {
        if (!seen.has(ch)) {
            seen.add(ch);
            chars.push(ch);
        }
    }
    if (chars.length === 0) {
        chars.push("@", "%", "#", "*", "+", "=", "-", ":", ".", " ");
    }
    if (chars.length === 1) {
        chars.push(" ");
    }
    const invert = boolOf(params, "invert", false);
    const dark = boolOf(params, "dark_background", true);
    const sourceColor = boolOf(params, "use_source_color", true);
    const charset = chars.join("");
    const grid = asciiGrid(src, cell, num(params, "contrast", 110), charset, invert, dark);

    const canvasAvailable = typeof document !== "undefined";
    if (canvasAvailable) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = dark ? "rgb(12,12,12)" : "#FFFFFF";
            ctx.fillRect(0, 0, w, h);
            ctx.font = `${Math.round(cell * 1.02)}px "Consolas", monospace`;
            ctx.textBaseline = "alphabetic";
            const cols = grid.columns;
            const rowsCount = grid.rowsCount;
            for (let ry = 0; ry < rowsCount; ry++) {
                const line = grid.rows[ry];
                for (let rx = 0; rx < cols; rx++) {
                    const ch = line[rx] ?? " ";
                    if (ch.trim().length === 0) {
                        continue;
                    }
                    const x0 = rx * cell;
                    const y0 = ry * cell;
                    const avg = avgCell(src, x0, y0, Math.min(w, x0 + cell), Math.min(h, y0 + cell));
                    const lum = clamp((lum01(avg[0], avg[1], avg[2]) - 0.5) * contrast + 0.5, 0, 1);
                    const value = invert ? 1 - lum : lum;
                    if (sourceColor) {
                        ctx.fillStyle = `rgb(${avg[0] | 0},${avg[1] | 0},${avg[2] | 0})`;
                    } else if (dark) {
                        const v = (0.8 + 0.2 * value) * 255;
                        ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
                    } else {
                        const v = (0.1 + 0.55 * (1 - value)) * 255;
                        ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
                    }
                    ctx.fillText(ch, x0, y0 + cell * 0.9);
                }
            }
            ctx.fillStyle = dark ? "rgb(12,12,12)" : "#FFFFFF";
            const right = grid.columns * cell;
            const bottom = grid.rowsCount * cell;
            if (right < w) {
                ctx.fillRect(right, 0, w - right, h);
            }
            if (bottom < h) {
                ctx.fillRect(0, bottom, Math.min(right, w), h - bottom);
            }
            const pixels = ctx.getImageData(0, 0, w, h);
            const out = makeImageData(w, h);
            out.data.set(pixels.data);
            return out;
        }
    }

    // Node fallback: solid block shading from the average cell luminance.
    const out = makeImageData(w, h);
    for (let ry = 0; ry < grid.rowsCount; ry++) {
        for (let rx = 0; rx < grid.columns; rx++) {
            const ch = grid.rows[ry][rx] ?? " ";
            const x0 = rx * cell;
            const y0 = ry * cell;
            const x1 = Math.min(w, x0 + cell);
            const y1 = Math.min(h, y0 + cell);
            const avg = avgCell(src, x0, y0, x1, y1);
            const lum = clamp((lum01(avg[0], avg[1], avg[2]) - 0.5) * contrast + 0.5, 0, 1);
            const value = invert ? 1 - lum : lum;
            const glyphIndex = chars.indexOf(ch);
            const density = glyphIndex >= 0 ? 1 - glyphIndex / Math.max(1, chars.length - 1) : value;
            const level = clamp01(density * 0.65 + value * 0.35);
            const shade = dark ? 10 + level * 200 : 250 - level * 150;
            const r = sourceColor ? avg[0] * (0.35 + level * 0.75) : shade;
            const g = sourceColor ? avg[1] * (0.35 + level * 0.75) : shade;
            const b = sourceColor ? avg[2] * (0.35 + level * 0.75) : shade;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * w + x) * 4;
                    out.data[i] = byte(r);
                    out.data[i + 1] = byte(g);
                    out.data[i + 2] = byte(b);
                    out.data[i + 3] = 255;
                }
            }
        }
    }
    return out;
};

const chalkDrawing: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const detail = clamp(num(params, "detail", 50), 0, 100) / 100;
    const roughness = clamp(num(params, "roughness", 40), 0, 100) / 100;
    const chalk = parseColor(strOf(params, "chalk_color", "#FFFFFF"));
    const board = parseColor(strOf(params, "board_color", "#1E3228"));
    const s = src.data;
    const gray = luminanceBuffer(src);
    const edges = sobelBuffer(gray, w, h);
    const edgeWeight = 0.3 + detail * 0.7;
    const lumWeight = 1 - edgeWeight * 0.5;
    const out = makeImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const i = idx * 4;
            const noise = hash01(x, y, 12345);
            let intensity = edges[idx] * edgeWeight + gray[idx] * lumWeight;
            intensity = clamp(intensity, 0, 1);
            intensity *= 1 - roughness * (1 - noise) * 0.6;
            intensity *= Math.sqrt(gray[idx]);
            intensity = clamp(intensity, 0, 1);
            packRgb(
                out,
                i,
                lerp(board[0] / 255, chalk[0] / 255, intensity),
                lerp(board[1] / 255, chalk[1] / 255, intensity),
                lerp(board[2] / 255, chalk[2] / 255, intensity),
                s[i + 3]
            );
        }
    }
    return out;
};

const crosshatchImpl: EffectImpl = (src, params, env) => {
    return crosshatch(
        src,
        pxCell(env, num(params, "lineSpacing", 8), 1),
        Math.max(0.5, env.px(num(params, "lineThickness", 1.2))),
        clamp(num(params, "contrast", 120), 1, 300),
        Math.round(clamp(num(params, "layerCount", 4), 1, 8))
    );
};

const embroidery: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const size = pxCell(env, num(params, "stitch_size", 10), 2);
    const colorCount = clamp(Math.round(num(params, "color_count", 16)), 2, 256);
    const showGrid = boolOf(params, "show_grid", true);
    const fabric = parseColor(strOf(params, "fabric_color", "#F0EBDC"));
    const levels = Math.max(2, Math.ceil(Math.pow(colorCount, 1 / 3)));
    const step = 255 / (levels - 1);
    const out = makeImageData(w, h);
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        d[i] = fabric[0];
        d[i + 1] = fabric[1];
        d[i + 2] = fabric[2];
        d[i + 3] = 255;
    }
    const gridCols = Math.ceil(w / size);
    const gridRows = Math.ceil(h / size);
    const margin = size * 0.1;
    const stroke = Math.max(1, size * 0.15) * 0.5;
    for (let gy = 0; gy < gridRows; gy++) {
        for (let gx = 0; gx < gridCols; gx++) {
            const x0 = gx * size;
            const y0 = gy * size;
            const x1 = Math.min(w, x0 + size);
            const y1 = Math.min(h, y0 + size);
            const avg = avgCell(src, x0, y0, x1, y1);
            const qr = Math.round(avg[0] / step) * step;
            const qg = Math.round(avg[1] / step) * step;
            const qb = Math.round(avg[2] / step) * step;
            const sx = x0 + margin;
            const sy = y0 + margin;
            const ex = x1 - margin;
            const ey = y1 - margin;
            const minX = Math.floor(Math.min(sx, ex));
            const maxX = Math.ceil(Math.max(sx, ex));
            const minY = Math.floor(Math.min(sy, ey));
            const maxY = Math.ceil(Math.max(sy, ey));
            for (let y = Math.max(y0, minY); y < Math.min(y1, maxY); y++) {
                for (let x = Math.max(x0, minX); x < Math.min(x1, maxX); x++) {
                    const t1 = Math.abs((x - sx) / Math.max(0.01, ex - sx) - (y - sy) / Math.max(0.01, ey - sy));
                    const t2 = Math.abs((x - sx) / Math.max(0.01, ex - sx) - (ey - y) / Math.max(0.01, ey - sy));
                    const dist = Math.min(t1, t2) * Math.max(1, Math.min(Math.abs(ex - sx), Math.abs(ey - sy)));
                    if (dist > stroke) {
                        continue;
                    }
                    const shade = 1 - 0.22 * (dist / Math.max(0.01, stroke));
                    const i = (y * w + x) * 4;
                    d[i] = byte(qr * shade);
                    d[i + 1] = byte(qg * shade);
                    d[i + 2] = byte(qb * shade);
                    d[i + 3] = 255;
                }
            }
        }
    }
    if (showGrid) {
        const gc = [Math.max(0, fabric[0] - 30), Math.max(0, fabric[1] - 30), Math.max(0, fabric[2] - 30)];
        for (let gx = 0; gx <= gridCols; gx++) {
            const x = Math.min(gx * size, w - 1);
            for (let y = 0; y < h; y++) {
                const i = (y * w + x) * 4;
                d[i] = byte(d[i] * 0.75 + gc[0] * 0.25);
                d[i + 1] = byte(d[i + 1] * 0.75 + gc[1] * 0.25);
                d[i + 2] = byte(d[i + 2] * 0.75 + gc[2] * 0.25);
            }
        }
        for (let gy = 0; gy <= gridRows; gy++) {
            const y = Math.min(gy * size, h - 1);
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                d[i] = byte(d[i] * 0.75 + gc[0] * 0.25);
                d[i + 1] = byte(d[i + 1] * 0.75 + gc[1] * 0.25);
                d[i + 2] = byte(d[i + 2] * 0.75 + gc[2] * 0.25);
            }
        }
    }
    return out;
};

const engravingImpl: EffectImpl = (src, params, env) => {
    return engraving(
        src,
        Math.max(2, env.px(num(params, "line_spacing", 5))),
        num(params, "angle", 45),
        Math.max(0.2, env.px(num(params, "line_width_max", 2.5))),
        strOf(params, "line_color", "#141428"),
        strOf(params, "paper_color", "#F5F0E6")
    );
};

const oilPaintImpl: EffectImpl = (src, params) => {
    return oilPaint(
        src,
        clamp(Math.round(num(params, "radius", 3)), 1, 10),
        clamp(Math.round(num(params, "levels", 24)), 4, 64)
    );
};

const pencilSketch: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const n = w * h;
    const radius = clamp(pxCell(env, num(params, "blur_radius", 8), 1), 1, 24);
    const edgeStrength = clamp(num(params, "edge_strength", 65), 0, 160) / 100;
    const darkness = clamp(num(params, "pencil_darkness", 70), 0, 100) / 100;
    const paper = clamp(num(params, "paper_brightness", 100), 40, 130) / 100;
    const gray = luminanceBuffer(src);
    const inverse = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        inverse[i] = 1 - gray[i];
    }
    const blurred = smoothBoxBlur(inverse, w, h, radius);
    const edges = sobelBuffer(gray, w, h);
    const gamma = 1 + darkness * 1.75;
    const paperLift = clamp(paper - 1, 0, 0.6);
    const out = makeImageData(w, h);
    const s = src.data;
    for (let i = 0; i < n; i++) {
        const dodge = gray[i] / Math.max(1 - blurred[i], 0.03);
        const sketch = clamp(dodge, 0, 1);
        let value = clamp(sketch - edges[i] * edgeStrength * 0.85, 0, 1);
        value = Math.pow(value, gamma);
        value = lerp(value, 1, paperLift);
        const v = byte(value * 255);
        const o = i * 4;
        out.data[o] = v;
        out.data[o + 1] = v;
        out.data[o + 2] = v;
        out.data[o + 3] = s[o + 3];
    }
    return out;
};

const pointillism: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const dotSize = clamp(pxCell(env, num(params, "dot_size", 7), 2), 2, 64);
    const density = clamp(num(params, "density", 72), 10, 100) / 100;
    const jitter = clamp(num(params, "jitter", 65), 0, 100) / 100;
    const boost = clamp(num(params, "color_boost", 20), 0, 100) / 100;
    const backgroundMix = clamp(num(params, "background_mix", 20), 0, 100) / 100;
    const seed = env.seed;
    const step = Math.max(2, dotSize);
    const jitterAmount = jitter * step * 0.6;
    const out = makeImageData(w, h);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        d[i] = byte(s[i] * backgroundMix + 255 * (1 - backgroundMix));
        d[i + 1] = byte(s[i + 1] * backgroundMix + 255 * (1 - backgroundMix));
        d[i + 2] = byte(s[i + 2] * backgroundMix + 255 * (1 - backgroundMix));
        d[i + 3] = 255;
    }
    const tmp = new Float32Array(4);
    const rows = Math.ceil(h / step);
    const cols = Math.ceil(w / step);
    for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
            if (hash01(gx, gy, seed) > density) {
                continue;
            }
            const jx = (hash01(gx, gy, seed ^ 111) * 2 - 1) * jitterAmount;
            const jy = (hash01(gx, gy, seed ^ 257) * 2 - 1) * jitterAmount;
            const cx = clamp(gx * step + step * 0.5 + jx, 0, w - 1);
            const cy = clamp(gy * step + step * 0.5 + jy, 0, h - 1);
            sampleBilinear(src, cx, cy, tmp, 0);
            let r = tmp[0];
            let g = tmp[1];
            let b = tmp[2];
            if (boost > 0) {
                [r, g, b] = saturate(r, g, b, boost);
            }
            const radiusJitter = 0.6 + hash01(gx, gy, seed ^ 509) * 0.9;
            const radius = Math.max(1, dotSize * 0.36 * radiusJitter);
            const r2 = radius * radius;
            const minX = Math.max(0, Math.floor(cx - radius));
            const maxX = Math.min(w - 1, Math.ceil(cx + radius));
            const minY = Math.max(0, Math.floor(cy - radius));
            const maxY = Math.min(h - 1, Math.ceil(cy + radius));
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const dx = x - cx;
                    const dy = y - cy;
                    if (dx * dx + dy * dy > r2) {
                        continue;
                    }
                    const i = (y * w + x) * 4;
                    d[i] = byte(r);
                    d[i + 1] = byte(g);
                    d[i + 2] = byte(b);
                    d[i + 3] = 255;
                }
            }
        }
    }
    return out;
};

// -------------------------------------------------------------- print / paint

const popArtGrid: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const strength = clamp(num(params, "strength", 60), 0, 100) / 100;
    const tints = [
        parseColor(strOf(params, "color1", "#FF3232")),
        parseColor(strOf(params, "color2", "#32C832")),
        parseColor(strOf(params, "color3", "#3232FF")),
        parseColor(strOf(params, "color4", "#FFC832")),
    ];
    const out = makeImageData(w, h);
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
        const cellY = y < halfH ? 0 : 1;
        const sy = y < halfH ? y : y - halfH;
        const srcY = Math.min(h - 1, Math.floor((sy * h) / Math.max(1, h - halfH)));
        for (let x = 0; x < w; x++) {
            const cellX = x < halfW ? 0 : 1;
            const sx = x < halfW ? x : x - halfW;
            const srcX = Math.min(w - 1, Math.floor((sx * w) / Math.max(1, w - halfW)));
            const i = (srcY * w + srcX) * 4;
            const gray = (s[i] + s[i + 1] + s[i + 2]) / 3 / 255;
            const tint = tints[cellY * 2 + cellX];
            const shade = 0.35 + gray * 0.9;
            const r = lerp(s[i] / 255, (tint[0] / 255) * shade, strength);
            const g = lerp(s[i + 1] / 255, (tint[1] / 255) * shade, strength);
            const b = lerp(s[i + 2] / 255, (tint[2] / 255) * shade, strength);
            const o = (y * w + x) * 4;
            packRgb(out, o, r, g, b, s[(y * w + x) * 4 + 3]);
        }
    }
    return out;
};

const risoPrint: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const inkStrength = clamp(num(params, "ink_strength", 70), 0, 100) / 100;
    if (inkStrength <= 0) {
        return cloneImageData(src);
    }
    const paperFade = clamp(num(params, "paper_fade", 25), 0, 100) / 100;
    const dotScale = clamp(num(params, "dot_scale", 18), 0, 100) / 100;
    const inkNoise = clamp(num(params, "ink_noise", 35), 0, 100) / 100;
    const misreg = clamp(num(params, "offset", 3), -200, 200) * 0.3;
    const inkA = parseColor(strOf(params, "ink_color_a", "#DC4646"));
    const inkB = parseColor(strOf(params, "ink_color_b", "#46C8D2"));
    const cell = clamp(Math.round(4 + dotScale * 20), 3, 28);
    const seed = 2026;
    const paperKeep = clamp01(1 - paperFade * 0.9);
    const s = src.data;
    const out = makeImageData(w, h);

    const dotMask = (x: number, y: number, coverage: number, inkSeed: number): number => {
        const cx = Math.floor(x / cell) * cell + Math.floor(cell / 2);
        const cy = Math.floor(y / cell) * cell + Math.floor(cell / 2);
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let radius = cell * 0.6 * Math.sqrt(Math.max(0, coverage));
        const hval = hash01(x, y, seed ^ inkSeed);
        radius *= 1 + 0.25 * (hval * 2 - 1) * inkNoise;
        const edge = 1 + 0.8 * inkNoise;
        return 1 - smoothstep(radius, radius + edge, dist);
    };

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const coverage = clamp01(Math.pow(1 - lum01(s[i], s[i + 1], s[i + 2]), 0.7));
            const a = clamp01(dotMask(x, y, coverage, 0xa11) * inkStrength * paperKeep);
            const b = clamp01(dotMask(Math.round(x + misreg), y, coverage, 0xb22) * inkStrength * paperKeep);
            let r = 1;
            let g = 1;
            let bl = 1;
            r = r * (1 - a) + (inkA[0] / 255) * a;
            g = g * (1 - a) + (inkA[1] / 255) * a;
            bl = bl * (1 - a) + (inkA[2] / 255) * a;
            r = r * (1 - b) + (inkB[0] / 255) * b;
            g = g * (1 - b) + (inkB[1] / 255) * b;
            bl = bl * (1 - b) + (inkB[2] / 255) * b;
            const grain = (hash01(x, y, seed ^ 0x99) * 2 - 1) * inkNoise * 0.06;
            out.data[i] = byte((r + grain) * 255);
            out.data[i + 1] = byte((g + grain * 0.92) * 255);
            out.data[i + 2] = byte((bl + grain * 1.06) * 255);
            out.data[i + 3] = s[i + 3];
        }
    }
    return out;
};

const woodcutPrint: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const threshold = clamp(num(params, "threshold", 50), 0, 100) / 100;
    const edgeWeight = clamp(num(params, "edge_strength", 60), 0, 100) / 100;
    const grainWeight = clamp(num(params, "grain_amount", 30), 0, 100) / 100;
    const ink = parseColor(strOf(params, "ink_color", "#0F0A05"));
    const paper = parseColor(strOf(params, "paper_color", "#EBE1C8"));
    const gray = luminanceBuffer(src);
    const edges = sobelBuffer(gray, w, h);
    const out = makeImageData(w, h);
    const s = src.data;
    const rowPhase = new Float32Array(h);
    const rand = mulberry32(7919);
    for (let y = 0; y < h; y++) {
        rowPhase[y] = rand() * Math.PI * 2;
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const wave = Math.sin(x * 0.08 + rowPhase[y]) * 0.5 + 0.5;
            const fine = Math.sin(x * 0.3 + y * 0.15 + rowPhase[y] * 2) * 0.5 + 0.5;
            const grain = wave * 0.6 + fine * 0.4;
            const localThreshold = threshold + (grain - 0.5) * grainWeight * 0.4;
            const score = gray[idx] - edges[idx] * edgeWeight;
            let inkAmount: number;
            if (score < localThreshold - 0.05) {
                inkAmount = 1;
            } else if (score > localThreshold + 0.05) {
                inkAmount = 0;
            } else {
                inkAmount = 1 - (score - (localThreshold - 0.05)) / 0.1;
            }
            const i = idx * 4;
            packRgb(
                out,
                i,
                lerp(paper[0] / 255, ink[0] / 255, inkAmount),
                lerp(paper[1] / 255, ink[1] / 255, inkAmount),
                lerp(paper[2] / 255, ink[2] / 255, inkAmount),
                s[i + 3]
            );
        }
    }
    return out;
};

const watercolorKuwahara: EffectImpl = (src, params) => {
    return kuwahara(
        src,
        clamp(Math.round(num(params, "radius", 4)), 1, 12),
        clamp(num(params, "saturation_boost", 20), 0, 100),
        clamp(num(params, "detail_blend", 18), 0, 100)
    );
};

const stainedGlass: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const tileSize = clamp(pxCell(env, num(params, "tile_size", 22), 6), 6, 120);
    const irregularity = clamp(num(params, "irregularity", 55), 0, 100) / 100;
    const leadWidth = clamp(env.px(num(params, "lead_width", 1.8)), 0, 12);
    const leadOpacity = clamp(num(params, "lead_opacity", 85), 0, 100) / 100;
    const colorBoost = clamp(num(params, "color_boost", 20), 0, 100) / 100;
    const s = src.data;
    const right = w - 1;
    const bottom = h - 1;
    const gridW = Math.ceil(w / tileSize) + 2;
    const gridH = Math.ceil(h / tileSize) + 2;
    const siteX = new Float32Array(gridW * gridH);
    const siteY = new Float32Array(gridW * gridH);
    const siteC = new Uint8ClampedArray(gridW * gridH * 3);
    const rand = mulberry32(deriveSeed(env.seed, "stained"));
    const jitterRange = tileSize * 0.5 * irregularity;
    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const baseX = (gx - 1 + 0.5) * tileSize;
            const baseY = (gy - 1 + 0.5) * tileSize;
            const ox = (rand() * 2 - 1) * jitterRange;
            const oy = (rand() * 2 - 1) * jitterRange;
            const cx = clamp(baseX + ox, 0, right);
            const cy = clamp(baseY + oy, 0, bottom);
            const sx = clamp(Math.round(cx), 0, right);
            const sy = clamp(Math.round(cy), 0, bottom);
            const si = (sy * w + sx) * 4;
            const idx = gy * gridW + gx;
            siteX[idx] = cx;
            siteY[idx] = cy;
            const sat = saturate(s[si], s[si + 1], s[si + 2], colorBoost);
            siteC[idx * 3] = byte(sat[0]);
            siteC[idx * 3 + 1] = byte(sat[1]);
            siteC[idx * 3 + 2] = byte(sat[2]);
        }
    }
    const out = makeImageData(w, h);
    for (let y = 0; y < h; y++) {
        const gy = Math.floor(y / tileSize) + 1;
        for (let x = 0; x < w; x++) {
            const gx = Math.floor(x / tileSize) + 1;
            let nearest = Number.POSITIVE_INFINITY;
            let second = Number.POSITIVE_INFINITY;
            let best = -1;
            for (let ny = gy - 1; ny <= gy + 1; ny++) {
                for (let nx = gx - 1; nx <= gx + 1; nx++) {
                    const id = ny * gridW + nx;
                    const dx = x - siteX[id];
                    const dy = y - siteY[id];
                    const d2 = dx * dx + dy * dy;
                    if (d2 < nearest) {
                        second = nearest;
                        nearest = d2;
                        best = id;
                    } else if (d2 < second) {
                        second = d2;
                    }
                }
            }
            const i = (y * w + x) * 4;
            if (best < 0) {
                out.data.set(s.subarray(i, i + 4), i);
                continue;
            }
            let r = siteC[best * 3];
            let g = siteC[best * 3 + 1];
            let b = siteC[best * 3 + 2];
            if (leadWidth > 0 && second < Number.POSITIVE_INFINITY) {
                const edgeDistance = (Math.sqrt(second) - Math.sqrt(nearest)) * 0.5;
                if (edgeDistance < leadWidth) {
                    const blend = (1 - edgeDistance / leadWidth) * leadOpacity;
                    r *= 1 - blend;
                    g *= 1 - blend;
                    b *= 1 - blend;
                }
            }
            out.data[i] = byte(r);
            out.data[i + 1] = byte(g);
            out.data[i + 2] = byte(b);
            out.data[i + 3] = s[i + 3];
        }
    }
    return out;
};

// ------------------------------------------------------------------- drawing

const blueprintDrawing: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const lineStrength = clamp(num(params, "line_strength", 75), 0, 100) / 100;
    const detail = clamp(num(params, "detail", 45), 0, 100) / 100;
    const grid = clamp(num(params, "grid_intensity", 30), 0, 100) / 100;
    const texture = clamp(num(params, "texture", 25), 0, 100) / 100;
    const glow = clamp(num(params, "glow", 35), 0, 100) / 100;
    const right = w - 1;
    const bottom = h - 1;
    const centerX = right * 0.5;
    const centerY = bottom * 0.5;
    const invSpacing = 1 / (10 + (1 - detail) * 20);
    const gray = luminanceBuffer(src);
    const out = makeImageData(w, h);
    const seed = 991;
    for (let y = 0; y < h; y++) {
        const yUp = Math.max(0, y - 1);
        const yDown = Math.min(bottom, y + 1);
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const xLeft = Math.max(0, x - 1);
            const xRight = Math.min(right, x + 1);
            const index = row + x;
            const lum = gray[index];
            const gradX = Math.abs(gray[row + xRight] - gray[row + xLeft]);
            const gradY = Math.abs(gray[yDown * w + x] - gray[yUp * w + x]);
            const edge = Math.min(1, (gradX + gradY) * (3.2 + lineStrength * 5.5));
            const tonal = Math.pow(1 - lum, 0.65 + (1 - detail) * 1.5) * (0.2 + detail * 0.4);
            const lineMask = clamp(Math.pow(edge, 0.62) * (0.9 + lineStrength * 0.85) + tonal * 0.55, 0, 1);
            const nx = x / Math.max(1, right);
            const ny = y / Math.max(1, bottom);
            const dx = (x - centerX) / Math.max(1, right);
            const dy = (y - centerY) / Math.max(1, bottom);
            const dist = Math.sqrt(dx * dx + dy * dy);
            const vig = 1 - smoothstep(0.35, 0.95, dist);
            const baseShade = 0.42 + 0.38 * vig;
            const gridX = Math.abs(x * invSpacing - Math.round(x * invSpacing));
            const gridY = Math.abs(y * invSpacing - Math.round(y * invSpacing));
            let gridLine = Math.max(1 - gridX * 18, 1 - gridY * 18);
            gridLine = clamp(gridLine, 0, 1) * grid * 0.45;
            const pna = (hash01(Math.floor(nx * 1024), Math.floor(ny * 1024), seed) * 2 - 1) * texture;
            const pnb = (hash01(Math.floor(nx * 320), Math.floor(ny * 320), seed ^ 431) * 2 - 1) * texture * 0.6;
            const paper = (pna + pnb) * 12;
            const br = 10 + 12 * baseShade + 16 * gridLine + paper;
            const bg = 52 + 46 * baseShade + 28 * gridLine + paper;
            const bb = 122 + 88 * baseShade + 46 * gridLine + paper;
            const glowMix = lineMask * (0.72 + glow * 0.28);
            let r = lerp(br, 230, glowMix);
            let g = lerp(bg, 242, glowMix);
            let b = lerp(bb, 255, glowMix);
            const cyan = lineMask * glow * 0.28;
            r = lerp(r, 136, cyan);
            g = lerp(g, 224, cyan);
            b = lerp(b, 255, cyan);
            const i = index * 4;
            out.data[i] = byte(r);
            out.data[i + 1] = byte(g);
            out.data[i + 2] = byte(b);
            out.data[i + 3] = s[i + 3];
        }
    }
    return out;
};

const cyanotype: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const contrast = clamp(num(params, "contrast", 118), 50, 200) / 100;
    const paperTexture = clamp(num(params, "paper_texture", 34), 0, 100) / 100;
    const stain = clamp(num(params, "stain", 28), 0, 100) / 100;
    const grain = clamp(num(params, "grain", 12), 0, 100) / 100;
    const vig = clamp(num(params, "vignette", 20), 0, 100) / 100;
    const centerX = (w - 1) * 0.5;
    const centerY = (h - 1) * 0.5;
    const maxDist = Math.max(1, Math.sqrt(centerX * centerX + centerY * centerY));
    const paper = [241, 236, 220];
    const mid = [87, 136, 170];
    const deep = [11, 45, 92];
    const seed = deriveSeed(env.seed, "cyanotype");
    const out = makeImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = clamp01((lum01(s[i], s[i + 1], s[i + 2]) - 0.5) * contrast + 0.5);
            const inkAmount = 1 - lum;
            let tr: number;
            let tg: number;
            let tb: number;
            if (inkAmount < 0.36) {
                const t = inkAmount / 0.36;
                tr = lerp(paper[0], mid[0], t) / 255;
                tg = lerp(paper[1], mid[1], t) / 255;
                tb = lerp(paper[2], mid[2], t) / 255;
            } else {
                const t = (inkAmount - 0.36) / 0.64;
                tr = lerp(mid[0], deep[0], t) / 255;
                tg = lerp(mid[1], deep[1], t) / 255;
                tb = lerp(mid[2], deep[2], t) / 255;
            }
            const paperNoise = (fbm(x * 0.022, y * 0.022, 4, 0.55, 2.1, seed) - 0.5) * paperTexture;
            const stainNoise = fbm(x * 0.006, y * 0.006, 5, 0.5, 2.0, seed ^ 901);
            const stainMask = smoothstep(0.56, 0.92, stainNoise) * stain;
            const grainNoise = (hash01(x, y, seed ^ 2111) * 2 - 1) * grain * 0.08;
            const radial = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / maxDist;
            const vigMask = clamp01(1 - vig * Math.pow(radial, 1.7) * 0.24);
            out.data[i] = byte(clamp01((tr + paperNoise * 0.08 + stainMask * 0.06 + grainNoise) * vigMask) * 255);
            out.data[i + 1] = byte(clamp01((tg + paperNoise * 0.1 + stainMask * 0.08 + grainNoise) * vigMask) * 255);
            out.data[i + 2] = byte(clamp01((tb + paperNoise * 0.14 + stainMask * 0.1 + grainNoise) * vigMask) * 255);
            out.data[i + 3] = s[i + 3];
        }
    }
    return out;
};

const wetPlateCollodion: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const contrast = clamp(num(params, "contrast", 132), 50, 200) / 100;
    const stains = clamp(num(params, "plate_stains", 34), 0, 100) / 100;
    const scratches = clamp(num(params, "scratches", 24), 0, 100) / 100;
    const silvering = clamp(num(params, "silvering", 36), 0, 100) / 100;
    const vig = clamp(num(params, "vignette", 58), 0, 100) / 100;
    const centerX = (w - 1) * 0.5;
    const centerY = (h - 1) * 0.5;
    const maxDist = Math.max(1, Math.sqrt(centerX * centerX + centerY * centerY));
    const shadow = [20, 16, 18];
    const highlight = [220, 213, 202];
    const seed = deriveSeed(env.seed, "wetplate");
    const out = makeImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = clamp01((lum01(s[i], s[i + 1], s[i + 2]) - 0.5) * contrast + 0.5);
            const t = Math.pow(lum, 0.88);
            const r0 = lerp(shadow[0], highlight[0], t) / 255;
            const g0 = lerp(shadow[1], highlight[1], t) / 255;
            const b0 = lerp(shadow[2], highlight[2], t) / 255;
            const chem = fbm(x * 0.008, y * 0.008, 5, 0.52, 2.05, seed);
            const streak = fbm(x * 0.024, y * 0.0026, 4, 0.48, 2.2, seed ^ 337);
            let stainMask = smoothstep(0.54, 0.92, chem) * stains;
            stainMask += Math.max(0, streak - 0.72) * stains * 0.45;
            const edgeDistance = Math.min(Math.min(x, w - 1 - x), Math.min(y, h - 1 - y));
            const edge01 = 1 - clamp(edgeDistance / Math.max(1, Math.min(w, h) * 0.16), 0, 1);
            const silverMask = silvering * edge01 * Math.pow(Math.max(lum, 0.02), 0.55);
            const radial = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / maxDist;
            const vigMask = clamp01(1 - vig * Math.pow(radial, 1.95) * 0.78);
            let scratchMask = 0;
            if (hash01(Math.floor(x / 3), y, seed ^ 173) > 0.9975) {
                scratchMask += scratches * 0.55;
            }
            if (hash01(x, Math.floor(y / 5), seed ^ 811) > 0.9984) {
                scratchMask += scratches * 0.35;
            }
            let r = lerp(r0, 0.88, silverMask * 0.34);
            let g = lerp(g0, 0.84, silverMask * 0.3);
            let b = lerp(b0, 0.92, silverMask * 0.38);
            out.data[i] = byte(clamp01((r - stainMask * 0.1 + scratchMask) * vigMask) * 255);
            out.data[i + 1] = byte(clamp01((g - stainMask * 0.08 + scratchMask) * vigMask) * 255);
            out.data[i + 2] = byte(clamp01((b - stainMask * 0.06 + scratchMask) * vigMask) * 255);
            out.data[i + 3] = s[i + 3];
        }
    }
    return out;
};

const disposableCamera: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const flash = clamp(num(params, "flash", 55), 0, 100) / 100;
    const softness = clamp(num(params, "softness", 8), 0, 24);
    const grain = clamp(num(params, "grain", 24), 0, 100) / 100;
    const vig = clamp(num(params, "vignette", 34), 0, 100) / 100;
    const warmth = clamp(num(params, "warmth", 42), 0, 100) / 100;
    const centerX = (w - 1) * 0.56;
    const centerY = (h - 1) * 0.44;
    const maxDist = Math.max(1, Math.sqrt(centerX * centerX + centerY * centerY));
    const blurred = softness > 0.01 ? gaussianBlur(src, env.px(softness)) : src;
    const sigmaInv = 1 / Math.max(0.0001, 2 * Math.pow(0.22 + flash * 0.2, 2));
    const softnessMix = (softness / 24) * 0.34;
    const contrast = 1.08 + flash * 0.16 + warmth * 0.08;
    const seed = deriveSeed(env.seed, "disposable");
    const out = makeImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            let r = lerp(s[i] / 255, blurred.data[i] / 255, softnessMix);
            let g = lerp(s[i + 1] / 255, blurred.data[i + 1] / 255, softnessMix);
            let b = lerp(s[i + 2] / 255, blurred.data[i + 2] / 255, softnessMix);
            r = clamp01((r - 0.5) * contrast + 0.5);
            g = clamp01((g - 0.5) * contrast + 0.5);
            b = clamp01((b - 0.5) * contrast + 0.5);
            const dx = (x - centerX) / Math.max(1, w - 1);
            const dy = (y - centerY) / Math.max(1, h - 1);
            const dist = Math.sqrt(dx * dx + dy * dy);
            const flashMask = flash * Math.exp(-(dist * dist) * sigmaInv);
            r = screen(r, flashMask * (0.22 + warmth * 0.1));
            g = screen(g, flashMask * 0.18);
            b = screen(b, flashMask * (0.11 - warmth * 0.02));
            if (warmth > 0.0001) {
                const warmMix = warmth * (0.14 + flashMask * 0.3);
                r = lerp(r, Math.min(1, r + 0.22), warmMix);
                g = lerp(g, Math.min(1, g + 0.1), warmMix * 0.75);
                b = lerp(b, Math.max(0, b - 0.05), warmMix * 0.7);
            }
            const radial = Math.sqrt((x - (w - 1) * 0.5) ** 2 + (y - (h - 1) * 0.5) ** 2) / maxDist;
            const vigMask = clamp01(1 - vig * Math.pow(radial, 1.85) * 0.62);
            const noise = (hash01(x, y, seed) * 2 - 1) * grain * 0.11;
            out.data[i] = byte(clamp01(r * vigMask + noise * 1.02) * 255);
            out.data[i + 1] = byte(clamp01(g * vigMask + noise) * 255);
            out.data[i + 2] = byte(clamp01(b * vigMask + noise * 0.92) * 255);
            out.data[i + 3] = s[i + 3];
        }
    }
    return out;
};

const luminanceContourLines: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const levels = clamp(Math.round(num(params, "levels", 12)), 2, 64);
    const lineWidth01 = clamp(num(params, "line_width", 6), 0, 200) / 200;
    const lineStrength = clamp(num(params, "line_strength", 65), 0, 100) / 100;
    const bgStrength = clamp(num(params, "background_strength", 20), 0, 100) / 100;
    const thresholdBias = clamp(num(params, "threshold", 0), 0, 255) / 255;
    const invert = boolOf(params, "invert", false);
    const lineColor = parseColor(strOf(params, "line_color", "#000000"));
    const feather = 0.04 + 0.22 * lineWidth01;
    const s = src.data;
    const out = makeImageData(w, h);
    for (let i = 0; i < s.length; i += 4) {
        const lumValue = clamp01(lum01(s[i], s[i + 1], s[i + 2]) + thresholdBias);
        const scaled = lumValue * levels;
        const qIndex = Math.floor(scaled);
        const frac = scaled - qIndex;
        const qLum = clamp01((qIndex + 0.5) / levels);
        const distToBoundary = Math.min(frac, 1 - frac);
        let lineMask = 1 - smoothstep(0, feather, distToBoundary);
        lineMask *= lineMask;
        if (invert) {
            lineMask = 1 - lineMask;
        }
        const bgLum = clamp01(lerp(lumValue, qLum, bgStrength));
        const lineMix = lineMask * lineStrength * (lineColor[3] / 255);
        out.data[i] = byte(lerp(bgLum, lineColor[0] / 255, lineMix) * 255);
        out.data[i + 1] = byte(lerp(bgLum, lineColor[1] / 255, lineMix) * 255);
        out.data[i + 2] = byte(lerp(bgLum, lineColor[2] / 255, lineMix) * 255);
        out.data[i + 3] = s[i + 3];
    }
    return out;
};

// --------------------------------------------------------------------- glitch

const blockGlitch: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const count = clamp(Math.round(num(params, "block_count", 36)), 0, 400);
    const minW = Math.max(1, env.px(num(params, "min_block_width", 24)));
    const maxW = Math.max(minW, env.px(num(params, "max_block_width", 200)));
    const minH = Math.max(1, env.px(num(params, "min_block_height", 6)));
    const maxH = Math.max(minH, env.px(num(params, "max_block_height", 50)));
    const maxDisp = env.px(num(params, "max_displacement", 50));
    const channelShift = Math.round(env.px(num(params, "channel_shift", 4)));
    const noiseAmount = clamp(num(params, "noise_amount", 10), 0, 100) / 100;
    const base = cloneImageData(src);
    const out = cloneImageData(src);
    const rand = mulberry32(deriveSeed(env.seed, "blockglitch"));
    for (let i = 0; i < count; i++) {
        const bw = Math.min(w, Math.round(minW + rand() * (maxW - minW)));
        const bh = Math.min(h, Math.round(minH + rand() * (maxH - minH)));
        const sx = Math.floor(rand() * Math.max(1, w - bw));
        const sy = Math.floor(rand() * Math.max(1, h - bh));
        const dx = Math.round((rand() * 2 - 1) * maxDisp);
        const dy = Math.round((rand() * 2 - 1) * maxDisp * 0.15);
        const tw = Math.min(bw, w - sx);
        const th = Math.min(bh, h - sy);
        for (let y = 0; y < th; y++) {
            const ty = sy + dy + y;
            if (ty < 0 || ty >= h) {
                continue;
            }
            const srcRow = (sy + y) * w + sx;
            const dstRow = ty * w + sx + dx;
            for (let x = 0; x < tw; x++) {
                const tx = sx + dx + x;
                if (tx < 0 || tx >= w) {
                    continue;
                }
                const si = (srcRow + x) * 4;
                const di = (dstRow + x) * 4;
                out.data[di] = base.data[si];
                out.data[di + 1] = base.data[si + 1];
                out.data[di + 2] = base.data[si + 2];
                out.data[di + 3] = base.data[si + 3];
            }
        }
    }
    if (channelShift !== 0 || noiseAmount > 0) {
        const sample = cloneImageData(out);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const xr = clamp(x + channelShift, 0, w - 1);
                const xb = clamp(x - channelShift, 0, w - 1);
                const noise = (hash01(x, y, env.seed ^ 701) * 2 - 1) * noiseAmount * 0.55;
                out.data[i] = byte(sample.data[(y * w + xr) * 4] + noise * 255);
                out.data[i + 1] = byte(sample.data[i + 1] + noise * 0.8 * 255);
                out.data[i + 2] = byte(sample.data[(y * w + xb) * 4 + 2] + noise * 1.15 * 255);
            }
        }
    }
    return out;
};

const glitchShift: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const intensity = clamp(num(params, "intensity", 30), 1, 100);
    const bands = clamp(Math.round(num(params, "bands", 12)), 2, 50);
    const shiftMax = Math.max(1, Math.round(env.px(intensity) * 0.6));
    const bandH = Math.max(1, Math.ceil(h / bands));
    const out = cloneImageData(src);
    const rand = mulberry32(deriveSeed(env.seed, "glitchshift"));
    for (let band = 0; band < bands; band++) {
        const y0 = band * bandH;
        const y1 = Math.min(h, y0 + bandH);
        const shift = Math.round((rand() * 2 - 1) * shiftMax);
        const chan = Math.round((rand() * 2 - 1) * Math.max(1, intensity * 0.08));
        const tint = rand() < 0.5 ? 1 : -1;
        for (let y = y0; y < y1; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const sx = clamp(x + shift, 0, w - 1);
                const si = (y * w + sx) * 4;
                const sr = clamp(x + shift + chan, 0, w - 1);
                const sb = clamp(x + shift - chan, 0, w - 1);
                out.data[i] = byte(src.data[(y * w + sr) * 4] * (1 + tint * 0.06));
                out.data[i + 1] = src.data[si + 1];
                out.data[i + 2] = byte(src.data[(y * w + sb) * 4 + 2] * (1 - tint * 0.06));
                out.data[i + 3] = src.data[si + 3];
            }
        }
    }
    return out;
};

const datamoshSmear: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const vertical = strOf(params, "direction", "Horizontal") === "Vertical";
    const smear = clamp(num(params, "smear_amount", 58), 0, 100) / 100;
    const corruption = clamp(num(params, "corruption", 36), 0, 100) / 100;
    const bs = clamp(Math.round(env.px(num(params, "block_size", 12))), 4, 64);
    const drift = clamp(num(params, "drift", 24), -100, 100);
    const channelSplit = clamp(num(params, "channel_split", 25), 0, 100) / 100;
    const base = cloneImageData(src);
    const out = cloneImageData(src);
    const rand = mulberry32(deriveSeed(env.seed, "datamosh"));
    const total = vertical ? Math.ceil(w / bs) : Math.ceil(h / bs);
    for (let b = 0; b < total; b++) {
        const start = b * bs;
        const end = Math.min(vertical ? w : h, start + bs);
        const mode = rand();
        if (mode < corruption * 0.45) {
            const shift = Math.round(drift * 0.5);
            for (let y = vertical ? 0 : start; y < (vertical ? h : end); y++) {
                for (let x = vertical ? start : 0; x < (vertical ? end : w); x++) {
                    const sx = vertical ? x : clamp(x + shift, 0, w - 1);
                    const sy = vertical ? clamp(y + shift, 0, h - 1) : y;
                    const si = (sy * w + sx) * 4;
                    const i = (y * w + x) * 4;
                    out.data[i] = base.data[si];
                    out.data[i + 1] = base.data[si + 1];
                    out.data[i + 2] = base.data[si + 2];
                    out.data[i + 3] = base.data[si + 3];
                }
            }
            continue;
        }
        const sampleX = vertical ? start : Math.floor(start + (end - start) * 0.5);
        const sampleY = vertical ? Math.floor(start + (end - start) * 0.5) : start;
        const si = (clamp(sampleY, 0, h - 1) * w + clamp(sampleX, 0, w - 1)) * 4;
        const sr = base.data[si];
        const sg = base.data[si + 1];
        const sb = base.data[si + 2];
        for (let y = vertical ? 0 : start; y < (vertical ? h : end); y++) {
            for (let x = vertical ? start : 0; x < (vertical ? end : w); x++) {
                const i = (y * w + x) * 4;
                const jitter = (hash01(x, y, env.seed ^ 71) * 2 - 1) * drift * 0.004;
                out.data[i] = byte(lerp(base.data[i], sr, smear) + jitter * 255);
                out.data[i + 1] = byte(lerp(base.data[i + 1], sg, smear) + jitter * 255);
                out.data[i + 2] = byte(lerp(base.data[i + 2], sb, smear) + jitter * 255);
            }
        }
    }
    if (channelSplit > 0) {
        const offset = Math.max(1, Math.round(env.px(3) * channelSplit * 2));
        const sample = cloneImageData(out);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                out.data[i] = sample.data[(y * w + clamp(x + offset, 0, w - 1)) * 4];
                out.data[i + 2] = sample.data[(y * w + clamp(x - offset, 0, w - 1)) * 4 + 2];
            }
        }
    }
    return out;
};

const pixelSortingImpl: EffectImpl = (src, params, env) => {
    const direction = strOf(params, "direction", "Vertical") === "Horizontal" ? "Horizontal" : "Vertical";
    const metric = strOf(params, "metric", "Brightness") === "Hue" ? "Hue" : "Brightness";
    const low = clamp(num(params, "threshold_low", 12), 0, 100) * 2.55;
    const high = clamp(num(params, "threshold_high", 85), 0, 100) * 2.55;
    const minSpan = Math.max(1, env.px(num(params, "min_span_length", 8)));
    const maxSpan = Math.max(minSpan, env.px(num(params, "max_span_length", 120)));
    const probability = clamp(num(params, "sort_probability", 85), 0, 100) / 100;
    return pixelSort(src, direction, metric, low, high, minSpan, maxSpan, probability, env.seed);
};

const jpegArtifact: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const compression = clamp(num(params, "compression", 62), 0, 100) / 100;
    const bs = clamp(Math.round(env.px(num(params, "block_size", 8))), 4, 32);
    const bleed = clamp(num(params, "chroma_bleed", 45), 0, 100) / 100;
    const ringing = clamp(num(params, "ringing", 28), 0, 100) / 100;
    const out = cloneImageData(src);
    const d = out.data;
    const s = src.data;
    for (let by = 0; by < h; by += bs) {
        const y1 = Math.min(h, by + bs);
        for (let bx = 0; bx < w; bx += bs) {
            const x1 = Math.min(w, bx + bs);
            let sr = 0;
            let sg = 0;
            let sb = 0;
            let n = 0;
            for (let y = by; y < y1; y++) {
                for (let x = bx; x < x1; x++) {
                    const i = (y * w + x) * 4;
                    sr += s[i];
                    sg += s[i + 1];
                    sb += s[i + 2];
                    n++;
                }
            }
            if (n === 0) {
                continue;
            }
            sr /= n;
            sg /= n;
            sb /= n;
            const blockY = (sr * 0.299 + sg * 0.587 + sb * 0.114) / 255;
            for (let y = by; y < y1; y++) {
                for (let x = bx; x < x1; x++) {
                    const i = (y * w + x) * 4;
                    const lum = (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
                    const chromaR = s[i] / 255 - lum;
                    const chromaG = s[i + 1] / 255 - lum;
                    const chromaB = s[i + 2] / 255 - lum;
                    let cr = blockY + lerp(chromaR, sr / 255 - blockY, bleed);
                    let cg = blockY + lerp(chromaG, sg / 255 - blockY, bleed);
                    let cb = blockY + lerp(chromaB, sb / 255 - blockY, bleed);
                    cr = lerp(cr, lum, compression * 0.35);
                    cg = lerp(cg, lum, compression * 0.35);
                    cb = lerp(cb, lum, compression * 0.35);
                    const ring = ringing * compression * 0.45;
                    if (ring > 0) {
                        const overshoot = (lum - blockY) * ring;
                        cr += overshoot;
                        cg += overshoot;
                        cb += overshoot;
                    }
                    d[i] = byte(cr * 255);
                    d[i + 1] = byte(cg * 255);
                    d[i + 2] = byte(cb * 255);
                    d[i + 3] = s[i + 3];
                }
            }
        }
    }
    if (compression > 0.01) {
        const blurred = gaussianBlur(out, 1);
        const amount = compression * 0.45;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = byte(d[i] + (d[i] - blurred.data[i]) * amount);
            d[i + 1] = byte(d[i + 1] + (d[i + 1] - blurred.data[i + 1]) * amount);
            d[i + 2] = byte(d[i + 2] + (d[i + 2] - blurred.data[i + 2]) * amount);
        }
    }
    return out;
};

const crt: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const scanline = clamp(num(params, "scanlineStrength", 35), 0, 100) / 100;
    const shift = Math.round(clamp(num(params, "rgbShift", 1), 0, 8));
    const noise = clamp(num(params, "noiseAmount", 8), 0, 100);
    const vignette = clamp(num(params, "vignetteStrength", 18), 0, 100) / 100;
    const right = w - 1;
    const noiseAmplitude = Math.round(noise * 0.6);
    const centerX = (w - 1) * 0.5;
    const centerY = (h - 1) * 0.5;
    const invCenterX = centerX > 0 ? 1 / centerX : 1;
    const invCenterY = centerY > 0 ? 1 / centerY : 1;
    const invSqrt2 = 0.70710678;
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let lineFactor = 1;
        if (scanline > 0) {
            const rowDarkness = (y & 1) === 0 ? 0.62 : 0.18;
            lineFactor = 1 - scanline * rowDarkness;
        }
        const dy = (y - centerY) * invCenterY;
        for (let x = 0; x < w; x++) {
            const index = row + x;
            const xr = clamp(x + shift, 0, right);
            const xb = clamp(x - shift, 0, right);
            let maskR = 1;
            let maskG = 1;
            let maskB = 1;
            switch (x % 3) {
                case 0:
                    maskR = 1.06;
                    maskG = 0.97;
                    maskB = 0.93;
                    break;
                case 1:
                    maskR = 0.93;
                    maskG = 1.06;
                    maskB = 0.97;
                    break;
                default:
                    maskR = 0.97;
                    maskG = 0.93;
                    maskB = 1.06;
                    break;
            }
            let vignetteFactor = 1;
            if (vignette > 0) {
                const dx = (x - centerX) * invCenterX;
                const distance01 = Math.sqrt(dx * dx + dy * dy) * invSqrt2;
                let t = (distance01 - 0.55) / 0.45;
                t = clamp01(t);
                const smooth = t * t * (3 - 2 * t);
                vignetteFactor = 1 - vignette * smooth;
            }
            const brightness = lineFactor * vignetteFactor;
            const nr = noiseAmplitude > 0 ? (hash01(x, y, env.seed ^ 11) * 2 - 1) * noiseAmplitude : 0;
            const ng = noiseAmplitude > 0 ? (hash01(x, y, env.seed ^ 37) * 2 - 1) * noiseAmplitude : 0;
            const nb = noiseAmplitude > 0 ? (hash01(x, y, env.seed ^ 73) * 2 - 1) * noiseAmplitude : 0;
            d[index * 4] = byte(s[(row + xr) * 4] * maskR * brightness + nr);
            d[index * 4 + 1] = byte(s[index * 4 + 1] * maskG * brightness + ng);
            d[index * 4 + 2] = byte(s[(row + xb) * 4 + 2] * maskB * brightness + nb);
            d[index * 4 + 3] = s[index * 4 + 3];
        }
    }
    return out;
};

const vhsTapeDamage: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const distortion = clamp(num(params, "distortion", 55), 0, 100) / 100;
    const noise = clamp(num(params, "noise", 28), 0, 100) / 100;
    const bleed = clamp(num(params, "color_bleed", 30), 0, 100) / 100;
    const tracking = clamp(num(params, "tracking", 24), 0, 100) / 100;
    const scanlines = clamp(num(params, "scanlines", 48), 0, 100) / 100;
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    const seed = deriveSeed(env.seed, "vhs");
    const trackingY = Math.floor(h * (0.18 + hash01(1, 0, seed) * 0.5));
    const trackingHeight = Math.max(2, Math.round(env.px(5)));
    const bleedPx = Math.max(1, Math.round(env.px(3) * bleed * 2));
    for (let y = 0; y < h; y++) {
        const wobble = Math.sin(y * 0.05 + hash01(0, y, seed) * 6.283) * distortion * 3;
        const band = y >= trackingY && y < trackingY + trackingHeight;
        const shiftX = Math.round(wobble + (band ? tracking * 36 : 0));
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const sx = clamp(x + shiftX, 0, w - 1);
            const sr = clamp(sx + bleedPx, 0, w - 1);
            const sb = clamp(sx - bleedPx, 0, w - 1);
            let r = lerp(s[(y * w + sx) * 4], s[(y * w + sr) * 4], bleed * 0.6);
            let g = s[(y * w + sx) * 4 + 1];
            let b = lerp(s[(y * w + sx) * 4 + 2], s[(y * w + sb) * 4 + 2], bleed * 0.6);
            if ((y & 1) === 0) {
                const factor = 1 - scanlines * 0.3;
                r *= factor;
                g *= factor;
                b *= factor;
            }
            const grain = (hash01(x, y, seed ^ 313) * 2 - 1) * noise * 38;
            if (hash01(x >> 2, y, seed ^ 919) > 0.993) {
                const streak = (hash01(x, y, seed ^ 55) - 0.4) * noise * 60;
                r += streak;
                g += streak;
                b += streak;
            }
            if (band) {
                r += 46;
                g += 41;
                b += 31;
            }
            d[i] = byte(r + grain);
            d[i + 1] = byte(g + grain);
            d[i + 2] = byte(b + grain);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const hologramScan: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const scanline = clamp(num(params, "scanline_strength", 45), 0, 100) / 100;
    const glitch = clamp(num(params, "glitch_amount", 25), 0, 100) / 100;
    const chroma = Math.round(env.px(num(params, "chroma_shift", 2)));
    const glow = clamp(num(params, "glow_amount", 30), 0, 100) / 100;
    const s = src.data;
    const base = cloneImageData(src);
    const bloom = gaussianBlur(src, Math.max(1, env.px(2.5)));
    const out = makeImageData(w, h);
    const d = out.data;
    const seed = deriveSeed(env.seed, "hologram");
    const rand = mulberry32(seed);
    const bandCount = Math.max(1, Math.round(4 + glitch * 16));
    const bandOffsets = new Float32Array(bandCount);
    for (let i = 0; i < bandCount; i++) {
        bandOffsets[i] = (rand() * 2 - 1) * glitch * 14;
    }
    for (let y = 0; y < h; y++) {
        const bandIndex = Math.floor((y / Math.max(1, h)) * bandCount);
        const shift = Math.round(bandOffsets[Math.min(bandCount - 1, bandIndex)]);
        const lineFactor = 1 - scanline * ((y & 1) === 0 ? 0.42 : 0.12) - scanline * 0.1;
        const flicker = 1 + Math.sin(y * 0.35 + bandIndex) * 0.02;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const sx = clamp(x + shift, 0, w - 1);
            const sr = clamp(sx + chroma, 0, w - 1);
            const sb = clamp(sx - chroma, 0, w - 1);
            let r = s[(y * w + sr) * 4] / 255;
            let g = s[(y * w + sx) * 4 + 1] / 255;
            let b = s[(y * w + sb) * 4 + 2] / 255;
            const tintR = r * 0.62 + g * 0.12 + b * 0.1;
            const tintG = r * 0.12 + g * 0.9 + b * 0.4;
            const tintB = r * 0.18 + g * 0.5 + b * 0.95;
            const bl = bloom.data[(y * w + sx) * 4];
            const bg = bloom.data[(y * w + sx) * 4 + 1];
            const bb = bloom.data[(y * w + sx) * 4 + 2];
            r = screen(tintR, (bl / 255) * glow * 0.55) * lineFactor * flicker;
            g = screen(tintG, (bg / 255) * glow * 0.75) * lineFactor * flicker;
            b = screen(tintB, (bb / 255) * glow * 0.65) * lineFactor * flicker;
            d[i] = byte(r * 255);
            d[i + 1] = byte(g * 255);
            d[i + 2] = byte(b * 255);
            d[i + 3] = base.data[i + 3];
        }
    }
    return out;
};

const matrixDigitalRain: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const cell = clamp(pxCell(env, num(params, "cell_size", 12), 6), 6, 24);
    const density = clamp(num(params, "density", 85), 0, 100) / 100;
    const trailLength = Math.max(1, Math.round(env.px(num(params, "trail_length", 12)) / 2));
    const glow = clamp(num(params, "glow_amount", 40), 0, 100) / 100;
    const sourceBlend = clamp(num(params, "source_blend", 22), 0, 100) / 100;
    const offset = clamp(num(params, "rain_offset", 0), 0, 100) / 100;
    const lumInfluence = clamp(num(params, "luminance_influence", 65), 0, 100) / 100;
    const charset = Array.from(strOf(params, "character_set", "01<>[]{}*+-/\\=#$%&"));
    const chars = charset.length > 0 ? charset : ["0", "1"];
    const seed = deriveSeed(env.seed, "matrix");
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    const out = cloneImageData(src);
    const d = out.data;
    const s = src.data;
    const green = new Float32Array(w * h);
    const glyphW = 3;
    const glyphH = 5;
    for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            const x0 = cx * cell;
            const y0 = cy * cell;
            const x1 = Math.min(w, x0 + cell);
            const y1 = Math.min(h, y0 + cell);
            const avg = avgCell(src, x0, y0, x1, y1);
            const lum = lum01(avg[0], avg[1], avg[2]);
            const densityEff = density * (1 - lumInfluence + lumInfluence * lum);
            const head = Math.floor(hash01(cx, 0, seed) * (rows + trailLength));
            const distance = ((head - cy + rows + trailLength * 4 - Math.floor(offset * rows * 2)) % (rows + trailLength) + rows + trailLength) % (rows + trailLength);
            let trail = clamp01(1 - distance / trailLength);
            trail = Math.pow(trail, 1.4);
            if (trail <= 0.03 || hash01(cx, cy, seed ^ 17) > densityEff + 0.1) {
                continue;
            }
            const glyph = chars[Math.floor(hash01(cx, cy, seed ^ 41) * chars.length)];
            const glyphSeed = hash01(cx, cy, seed ^ 77);
            for (let y = y0; y < y1; y++) {
                const ry = Math.min(glyphH - 1, Math.floor(((y - y0) / Math.max(1, y1 - y0)) * glyphH));
                for (let x = x0; x < x1; x++) {
                    const rx = Math.min(glyphW - 1, Math.floor(((x - x0) / Math.max(1, x1 - x0)) * glyphW));
                    const on = glyphSeed + hash01(rx + cx * 7, ry + cy * 11, seed ^ 91) > 0.45;
                    const i = (y * w + x) * 4;
                    const baseR = s[i] / 255;
                    const baseG = s[i + 1] / 255;
                    const baseB = s[i + 2] / 255;
                    const glyphBright = on ? (distance <= 0 ? 1 : 0.35 + trail * 0.65) : 0.08;
                    const rainR = 0.05 * glyphBright;
                    const rainG = (0.55 + trail * 0.45) * glyphBright;
                    const rainB = 0.18 * glyphBright;
                    const mix = clamp01(trail * (on ? 1 : 0.35)) * (1 - sourceBlend * 0.75);
                    let r = lerp(baseR, rainR + baseR * 0.08, mix);
                    let g = lerp(baseG, rainG + baseG * 0.1, mix);
                    let b = lerp(baseB, rainB + baseB * 0.08, mix);
                    const headGlow = distance === 0 ? 0.25 : 0;
                    r += headGlow * 0.5;
                    g += headGlow;
                    b += headGlow * 0.6;
                    d[i] = byte(r * 255);
                    d[i + 1] = byte(g * 255);
                    d[i + 2] = byte(b * 255);
                    green[y * w + x] = Math.max(green[y * w + x], g * mix);
                }
            }
        }
    }
    if (glow > 0.01) {
        const blurRadius = Math.max(1, Math.round(cell * 0.5));
        const halo = smoothBoxBlur(green, w, h, blurRadius);
        for (let i = 0; i < green.length; i++) {
            const amount = clamp01(halo[i] * glow * 0.9);
            if (amount <= 0) {
                continue;
            }
            const o = i * 4;
            d[o] = byte(d[o] + 4 * amount);
            d[o + 1] = byte(d[o + 1] + 130 * amount);
            d[o + 2] = byte(d[o + 2] + 22 * amount);
        }
    }
    return out;
};

const xRayScan: EffectImpl = (src, params) => {
    const w = src.width;
    const h = src.height;
    const contrast = clamp(num(params, "contrast", 70), 0, 100) / 100;
    const glow = clamp(num(params, "glow", 60), 0, 100) / 100;
    const edgeBoost = clamp(num(params, "edge_boost", 68), 0, 100) / 100;
    const scanlines = clamp(num(params, "scanlines", 40), 0, 100) / 100;
    const noise = clamp(num(params, "noise", 14), 0, 100) / 100;
    const gray = luminanceBuffer(src);
    const edges = sobelBuffer(gray, w, h);
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 2);
        const y1 = Math.min(h - 1, y + 2);
        const invLine = 1 - scanlines * ((y & 1) === 0 ? 0.34 : 0.1);
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const x0 = Math.max(0, x - 2);
            const x1 = Math.min(w - 1, x + 2);
            const blurred = (gray[y0 * w + x0] + gray[y0 * w + x1] + gray[y1 * w + x0] + gray[y1 * w + x1]) / 4;
            const inv = 1 - gray[y * w + x];
            const contrastValue = clamp01((inv - 0.5) * (0.7 + contrast * 1.3) + 0.5);
            const glowValue = clamp01((1 - blurred) * glow * 0.55);
            const edgeValue = edges[y * w + x] * edgeBoost;
            let value = clamp01(contrastValue + glowValue + edgeValue * 0.6);
            value = Math.pow(value, 0.95);
            const grain = (hash01(x, y, 4241) * 2 - 1) * noise * 0.16;
            const r = value * 0.55 + grain;
            const g = value * 0.82 + grain;
            const b = value * 1.05 + grain;
            d[i] = byte(clamp01(r) * 255 * invLine);
            d[i + 1] = byte(clamp01(g) * 255 * invLine);
            d[i + 2] = byte(clamp01(b) * 255 * invLine);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const animeSpeedLines: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const density = clamp(num(params, "density", 70), 10, 100) / 100;
    const strength = clamp(num(params, "strength", 65), 0, 100) / 100;
    const focusRadius = clamp(num(params, "focus_radius", 18), 0, 80) / 100;
    const centerX = (w - 1) * (clamp(num(params, "center_x", 50), 0, 100) / 100);
    const centerY = (h - 1) * (clamp(num(params, "center_y", 50), 0, 100) / 100);
    const contrast = clamp(num(params, "contrast", 35), 0, 100) / 100;
    const maxRadius = Math.max(1, Math.hypot(Math.max(centerX, w - 1 - centerX), Math.max(centerY, h - 1 - centerY)));
    const focus = maxRadius * focusRadius;
    const seed = deriveSeed(env.seed, "speedlines");
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = s[i];
            const g = s[i + 1];
            const b = s[i + 2];
            const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            let desat = 1 - contrast * 0.55;
            const dx = x - centerX;
            const dy = y - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const radial = clamp01(dist / maxRadius);
            if (dist < focus) {
                desat *= clamp01(dist / Math.max(1, focus));
            }
            const realR = lerp(gray, r / 255, clamp01(desat + 0.2));
            const realG = lerp(gray, g / 255, clamp01(desat + 0.2));
            const realB = lerp(gray, b / 255, clamp01(desat + 0.2));
            const angle = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
            const stripeHash = hash01(Math.floor(gray * 96), Math.floor(angle * 220), seed);
            const lineThreshold = density * (0.25 + radial * 0.75);
            let rr = realR;
            let rg = realG;
            let rb = realB;
            if (stripeHash < lineThreshold) {
                const widthHash = hash01(Math.floor(gray * 96), Math.floor(angle * 220), seed ^ 101);
                const lineValue = gray < 0.5 ? widthHash : 1 - widthHash;
                const intensity = clamp01(strength * (0.3 + radial * 0.7));
                rr = lerp(realR, lineValue, intensity);
                rg = lerp(realG, lineValue, intensity);
                rb = lerp(realB, lineValue, intensity);
            }
            d[i] = byte(rr * 255);
            d[i + 1] = byte(rg * 255);
            d[i + 2] = byte(rb * 255);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const oldCameraFlashBurn: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const flash = clamp(num(params, "flash_strength", 70), 0, 100) / 100;
    const radius = clamp(num(params, "flash_radius", 68), 20, 100) / 100;
    const edgeBurn = clamp(num(params, "edge_burn", 45), 0, 100) / 100;
    const warmth = clamp(num(params, "warmth", 35), 0, 100) / 100;
    const grain = clamp(num(params, "grain", 20), 0, 100) / 100;
    const centerX = (w - 1) * (clamp(num(params, "center_x", 50), 0, 100) / 100);
    const centerY = (h - 1) * (clamp(num(params, "center_y", 50), 0, 100) / 100);
    const maxDistance = Math.max(1, Math.hypot(w - 1, h - 1) * 0.5);
    const sigma = Math.max(0.001, radius * 0.55);
    const seed = deriveSeed(env.seed, "flashburn");
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const dx = (x - centerX) / maxDistance;
            const dy = (y - centerY) / maxDistance;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const flashMask = Math.exp(-(dist * dist) / (2 * sigma * sigma));
            let r = clamp01(s[i] / 255 + flash * flashMask * 0.55);
            let g = clamp01(s[i + 1] / 255 + flash * flashMask * 0.52);
            let b = clamp01(s[i + 2] / 255 + flash * flashMask * 0.45);
            r = clamp01(r * (1 + warmth * 0.24));
            g = clamp01(g * (1 + warmth * 0.1));
            b = clamp01(b * (1 - warmth * 0.12));
            const edge = 1 - edgeBurn * Math.pow(clamp01(dist), 2.2) * 0.55;
            const noiseVal = (hash01(x, y, seed) * 2 - 1) * grain * 0.16;
            d[i] = byte(clamp01(r * edge + noiseVal) * 255);
            d[i + 1] = byte(clamp01(g * edge + noiseVal * 0.9) * 255);
            d[i + 2] = byte(clamp01(b * edge + noiseVal * 0.8) * 255);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const vintagePrintDamage: EffectImpl = (src, params, env) => {
    const w = src.width;
    const h = src.height;
    const sepia = clamp(num(params, "sepia_amount", 65), 0, 100) / 100;
    const fade = clamp(num(params, "fade_amount", 30), 0, 100) / 100;
    const grain = clamp(num(params, "grain_amount", 25), 0, 100) / 100;
    const scratch = clamp(num(params, "scratch_amount", 25), 0, 100) / 100;
    const dust = clamp(num(params, "dust_amount", 20), 0, 100) / 100;
    const seed = deriveSeed(env.seed, "vintage");
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
            let sr = Math.min(255, 0.393 * lum + 0.769 * lum * 1.0 + 0.189 * lum * 0.4);
            let sg = Math.min(255, 0.349 * lum + 0.686 * lum + 0.168 * lum);
            let sb = Math.min(255, 0.272 * lum + 0.534 * lum + 0.131 * lum);
            let r = lerp(s[i], sr, sepia);
            let g = lerp(s[i + 1], sg, sepia);
            let b = lerp(s[i + 2], sb, sepia);
            const fadeMix = fade * 0.75;
            r = lerp(r, 245, fadeMix);
            g = lerp(g, 238, fadeMix);
            b = lerp(b, 222, fadeMix);
            const noiseVal = (hash01(x, y, seed) * 2 - 1) * grain * 0.5;
            d[i] = byte(r + noiseVal);
            d[i + 1] = byte(g + noiseVal);
            d[i + 2] = byte(b + noiseVal);
            d[i + 3] = s[i + 3];
        }
    }
    const rand = mulberry32(seed ^ 0x5147);
    const scratchCount = Math.round(scratch * Math.min(24, (w * h) / 9000));
    for (let n = 0; n < scratchCount; n++) {
        const x = Math.floor(rand() * w);
        const y0 = Math.floor(rand() * h * 0.4);
        const length = Math.max(4, Math.floor((0.15 + rand() * 0.7) * h));
        const bright = rand() > 0.45;
        const offx = Math.round((rand() * 2 - 1) * 1.5);
        for (let y = y0; y < Math.min(h, y0 + length); y++) {
            const xx = clamp(x + (y - y0) * 0 + offx, 0, w - 1);
            const i = (y * w + xx) * 4;
            const target = bright ? 235 : 25;
            const mix = 0.25 + rand() * 0.25;
            d[i] = byte(lerp(d[i], target, mix));
            d[i + 1] = byte(lerp(d[i + 1], target, mix));
            d[i + 2] = byte(lerp(d[i + 2], target, mix));
        }
    }
    const dustCount = Math.round(dust * Math.min(120, (w * h) / 1200));
    for (let n = 0; n < dustCount; n++) {
        const cx = Math.floor(rand() * w);
        const cy = Math.floor(rand() * h);
        const rad = Math.max(0.6, rand() * 2.2);
        const bright = rand() > 0.5;
        const target = bright ? 240 : 22;
        const alpha = 0.3 + rand() * 0.4;
        const r2 = rad * rad;
        for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++) {
            for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++) {
                const ddx = x - cx;
                const ddy = y - cy;
                if (ddx * ddx + ddy * ddy > r2) {
                    continue;
                }
                const i = (y * w + x) * 4;
                d[i] = byte(lerp(d[i], target, alpha));
                d[i + 1] = byte(lerp(d[i + 1], target, alpha));
                d[i + 2] = byte(lerp(d[i + 2], target, alpha));
            }
        }
    }
    return out;
};

// ------------------------------------------------------------------- registry

export const FILTER_F4_IMPLS: EffectRegistry = {
    ascii_art: asciiArt,
    chalk_drawing: chalkDrawing,
    crosshatch: crosshatchImpl,
    embroidery,
    engraving: engravingImpl,
    oil_paint: oilPaintImpl,
    pencil_sketch: pencilSketch,
    pointillism,
    pop_art_grid: popArtGrid,
    riso_print: risoPrint,
    woodcut_print: woodcutPrint,
    watercolor_kuwahara: watercolorKuwahara,
    stained_glass: stainedGlass,
    blueprint_drawing: blueprintDrawing,
    cyanotype,
    wet_plate_collodion: wetPlateCollodion,
    disposable_camera: disposableCamera,
    luminance_contour_lines: luminanceContourLines,
    block_glitch: blockGlitch,
    glitch_shift: glitchShift,
    datamosh_smear: datamoshSmear,
    pixel_sorting: pixelSortingImpl,
    jpeg_artifact: jpegArtifact,
    crt,
    vhs_tape_damage: vhsTapeDamage,
    hologram_scan: hologramScan,
    matrix_digital_rain: matrixDigitalRain,
    x_ray_scan: xRayScan,
    anime_speed_lines: animeSpeedLines,
    old_camera_flash_burn: oldCameraFlashBurn,
    vintage_print_damage: vintagePrintDamage,
};

export const FILTER_F4_FRAME_IDS: string[] = [];
