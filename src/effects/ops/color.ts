/**
 * Colour operations: matrices, lookup tables, tonal adjustments and channel
 * remapping. Every entry point is pure and returns a new ImageData.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    luminance,
    makeImageData,
    parseColor,
} from "../pixels.ts";

/** 256-entry transfer curve for a single channel. */
export type Lut = Uint8ClampedArray;

/** Per-channel transfer curves; alpha is optional. */
export interface ChannelLuts {
    r: Lut;
    g: Lut;
    b: Lut;
    a?: Lut;
}

export type LutLike = Lut | ChannelLuts;

/** Identity 4x5 colour matrix (rows = r,g,b,a, offset column in 0..255). */
export function identityColorMatrix(): number[] {
    return [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
    ];
}

/** Applies a 4x5 colour matrix; offsets are in 0..255 units. */
export function applyColorMatrix(src: ImageData, m: number[]): ImageData {
    if (!Array.isArray(m) || m.length !== 20) {
        return cloneImageData(src);
    }
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    const [
        rr, rg, rb, ra, ro,
        gr, gg, gb, ga, go,
        br, bg, bb, ba, bo,
        ar, ag, ab, aa, ao,
    ] = m;
    for (let i = 0; i < s.length; i += 4) {
        const r = s[i];
        const g = s[i + 1];
        const b = s[i + 2];
        const a = s[i + 3];
        d[i] = clamp255(rr * r + rg * g + rb * b + ra * a + ro);
        d[i + 1] = clamp255(gr * r + gg * g + gb * b + ga * a + go);
        d[i + 2] = clamp255(br * r + bg * g + bb * b + ba * a + bo);
        d[i + 3] = clamp255(ar * r + ag * g + ab * b + aa * a + ao);
    }
    return out;
}

/** Builds a 256-entry lookup table from a transfer function. */
export function buildLut(curve: (value: number) => number): Lut {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        const next = curve(i);
        lut[i] = Number.isFinite(next) ? next : i;
    }
    return lut;
}

/** Applies one shared curve or per-channel curves to an image. */
export function applyLut(src: ImageData, lut: LutLike): ImageData {
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    const rLut = lut instanceof Uint8ClampedArray ? lut : lut.r;
    const gLut = lut instanceof Uint8ClampedArray ? lut : lut.g;
    const bLut = lut instanceof Uint8ClampedArray ? lut : lut.b;
    const aLut = lut instanceof Uint8ClampedArray ? undefined : lut.a;
    for (let i = 0; i < s.length; i += 4) {
        d[i] = rLut[s[i]];
        d[i + 1] = gLut[s[i + 1]];
        d[i + 2] = bLut[s[i + 2]];
        d[i + 3] = aLut ? aLut[s[i + 3]] : s[i + 3];
    }
    return out;
}

/** Adds a constant brightness offset (-100..100 → ±255). */
export function brightness(src: ImageData, amount: number): ImageData {
    const offset = (clamp(amount, -100, 100) / 100) * 255;
    return applyLut(src, buildLut((v) => v + offset));
}

/** Expands or compresses contrast around mid-grey (-100..100). */
export function contrast(src: ImageData, amount: number): ImageData {
    const factor = (100 + clamp(amount, -100, 100)) / 100;
    return applyLut(src, buildLut((v) => (v - 128) * factor + 128));
}

/** Exposure in stops (-100..100 maps to ±2 EV). */
export function exposure(src: ImageData, amount: number): ImageData {
    const factor = Math.pow(2, clamp(amount, -100, 100) / 50);
    return applyLut(src, buildLut((v) => v * factor));
}

/** Gamma correction (amount 1 = identity, >1 brightens midtones). */
export function gamma(src: ImageData, amount: number): ImageData {
    const g = clamp(amount, 0.01, 10);
    const inv = 1 / g;
    const lut = buildLut((v) => 255 * Math.pow(v / 255, inv));
    return applyLut(src, lut);
}

/** Saturation around luminance; -100 = grey, +100 = doubled. */
export function saturation(src: ImageData, amount: number): ImageData {
    const f = 1 + clamp(amount, -100, 100) / 100;
    const lr = 0.2126;
    const lg = 0.7152;
    const lb = 0.0722;
    const nr = lr * (1 - f) + f;
    const ng = lg * (1 - f);
    const nb = lb * (1 - f);
    const mr = lr * (1 - f);
    const mg = lg * (1 - f) + f;
    const mb = lb * (1 - f);
    const hr = lr * (1 - f);
    const hg = lg * (1 - f);
    const hb = lb * (1 - f) + f;
    return applyColorMatrix(src, [
        nr, ng, nb, 0, 0,
        mr, mg, mb, 0, 0,
        hr, hg, hb, 0, 0,
        0, 0, 0, 1, 0,
    ]);
}

/** Vibrance boosts low-saturation pixels more than saturated ones. */
export function vibrance(src: ImageData, amount: number): ImageData {
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    const strength = clamp(amount, -100, 100) / 100;
    for (let i = 0; i < s.length; i += 4) {
        const r = s[i];
        const g = s[i + 1];
        const b = s[i + 2];
        const lum = luminance(r, g, b);
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        const f = 1 + strength * (1 - sat) * 0.9;
        d[i] = clamp255(lum + (r - lum) * f);
        d[i + 1] = clamp255(lum + (g - lum) * f);
        d[i + 2] = clamp255(lum + (b - lum) * f);
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Rotates hue by degrees using the CSS hue-rotate matrix. */
export function hueRotate(src: ImageData, degrees: number): ImageData {
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const lr = 0.213;
    const lg = 0.715;
    const lb = 0.072;
    return applyColorMatrix(src, [
        lr + cos * (1 - lr) + sin * -lr,
        lg + cos * -lg + sin * -lg,
        lb + cos * -lb + sin * (1 - lb),
        0, 0,
        lr + cos * -lr + sin * 0.143,
        lg + cos * (1 - lg) + sin * 0.14,
        lb + cos * -lb + sin * -0.283,
        0, 0,
        lr + cos * -lr + sin * -(1 - lr),
        lg + cos * -lg + sin * lg,
        lb + cos * (1 - lb) + sin * lb,
        0, 0,
        0, 0, 0, 1, 0,
    ]);
}

/** Blends toward luminance grey; strength 0..100. */
export function grayscale(src: ImageData, strength = 100): ImageData {
    const f = clamp(strength, 0, 100) / 100;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const lum = luminance(s[i], s[i + 1], s[i + 2]);
        d[i] = clamp255(s[i] + (lum - s[i]) * f);
        d[i + 1] = clamp255(s[i + 1] + (lum - s[i + 1]) * f);
        d[i + 2] = clamp255(s[i + 2] + (lum - s[i + 2]) * f);
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Blends toward a sepia tone; strength 0..100. */
export function sepia(src: ImageData, strength = 100): ImageData {
    const f = clamp(strength, 0, 100) / 100;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const r = s[i];
        const g = s[i + 1];
        const b = s[i + 2];
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        d[i] = clamp255(r + (sr - r) * f);
        d[i + 1] = clamp255(g + (sg - g) * f);
        d[i + 2] = clamp255(b + (sb - b) * f);
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Inverts RGB channels, preserving alpha. */
export function invert(src: ImageData): ImageData {
    return applyLut(src, buildLut((v) => 255 - v));
}

/** Scales the alpha channel by amount/100 (0..100). */
export function alphaAmount(src: ImageData, amount: number): ImageData {
    const f = clamp(amount, 0, 100) / 100;
    return applyLut(src, {
        r: buildLut((v) => v),
        g: buildLut((v) => v),
        b: buildLut((v) => v),
        a: buildLut((v) => v * f),
    });
}

/** Binarises on luminance at the given value (0..255). */
export function threshold(src: ImageData, value: number): ImageData {
    const cut = clamp(value, 0, 255);
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const v = luminance(s[i], s[i + 1], s[i + 2]) >= cut ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Quantises each channel to `levels` evenly spaced steps. */
export function posterize(src: ImageData, levels: number): ImageData {
    const n = Math.max(2, Math.round(levels));
    const lut = buildLut((v) => Math.round((v / 255) * (n - 1)) * (255 / (n - 1)));
    return applyLut(src, lut);
}

/** Inverts channels above the threshold (classic solarisation). */
export function solarize(src: ImageData, thresholdValue: number): ImageData {
    const cut = clamp(thresholdValue, 0, 255);
    return applyLut(src, buildLut((v) => (v >= cut ? 255 - v : v)));
}

/** Photoshop-style input/output levels with gamma. */
export function levels(
    src: ImageData,
    inputBlack: number,
    inputWhite: number,
    gammaValue: number,
    outputBlack: number,
    outputWhite: number
): ImageData {
    const ib = clamp(inputBlack, 0, 255);
    const iw = clamp(inputWhite, 1, 255);
    const ob = clamp(outputBlack, 0, 255);
    const ow = clamp(outputWhite, 0, 255);
    const g = clamp(gammaValue, 0.01, 10);
    const span = iw - ib || 1;
    const inv = 1 / g;
    const lut = buildLut((v) => {
        const t = clamp((v - ib) / span, 0, 1);
        return ob + Math.pow(t, inv) * (ow - ob);
    });
    return applyLut(src, lut);
}

export interface ColorBalanceParams {
    shadowCyanRed: number;
    shadowMagentaGreen: number;
    shadowYellowBlue: number;
    midCyanRed: number;
    midMagentaGreen: number;
    midYellowBlue: number;
    highlightCyanRed: number;
    highlightMagentaGreen: number;
    highlightYellowBlue: number;
}

/** Three-way colour balance for shadows, midtones and highlights. */
export function colorBalance(src: ImageData, p: ColorBalanceParams): ImageData {
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    const scale = 64 / 100;
    for (let i = 0; i < s.length; i += 4) {
        const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
        const sw = (1 - lum) * (1 - lum);
        const mw = 4 * lum * (1 - lum);
        const hw = lum * lum;
        const dr =
            (p.shadowCyanRed * sw + p.midCyanRed * mw + p.highlightCyanRed * hw) * scale;
        const dg =
            (p.shadowMagentaGreen * sw + p.midMagentaGreen * mw + p.highlightMagentaGreen * hw) * scale;
        const db =
            (p.shadowYellowBlue * sw + p.midYellowBlue * mw + p.highlightYellowBlue * hw) * scale;
        d[i] = clamp255(s[i] + dr);
        d[i + 1] = clamp255(s[i + 1] + dg);
        d[i + 2] = clamp255(s[i + 2] + db);
        d[i + 3] = s[i + 3];
    }
    return out;
}

export type ChannelSwapMode =
    | "RedGreen"
    | "RedBlue"
    | "GreenBlue"
    | "RotateRGB"
    | "RotateBGR";

/** Swaps or rotates the RGB channels. */
export function channelSwap(src: ImageData, mode: ChannelSwapMode): ImageData {
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const r = s[i];
        const g = s[i + 1];
        const b = s[i + 2];
        if (mode === "RedGreen") {
            d[i] = g;
            d[i + 1] = r;
            d[i + 2] = b;
        } else if (mode === "RedBlue") {
            d[i] = b;
            d[i + 1] = g;
            d[i + 2] = r;
        } else if (mode === "GreenBlue") {
            d[i] = r;
            d[i + 1] = b;
            d[i + 2] = g;
        } else if (mode === "RotateRGB") {
            d[i] = b;
            d[i + 1] = r;
            d[i + 2] = g;
        } else {
            d[i] = g;
            d[i + 1] = b;
            d[i + 2] = r;
        }
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Tints luminance with a solid colour; strength 0..100. */
export function colorize(src: ImageData, color: string, strength: number): ImageData {
    const [cr, cg, cb] = parseColor(color);
    const f = clamp(strength, 0, 100) / 100;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
        const tr = (cr / 255) * lum * 255;
        const tg = (cg / 255) * lum * 255;
        const tb = (cb / 255) * lum * 255;
        d[i] = clamp255(s[i] + (tr - s[i]) * f);
        d[i + 1] = clamp255(s[i + 1] + (tg - s[i + 1]) * f);
        d[i + 2] = clamp255(s[i + 2] + (tb - s[i + 2]) * f);
        d[i + 3] = s[i + 3];
    }
    return out;
}

export interface DuotoneParams {
    shadowColor: string;
    midtoneColor: string;
    highlightColor: string;
    contrast: number;
    gamma: number;
    blend: number;
}

/** Maps luminance through a three-stop gradient; optional contrast/gamma. */
export function duotone(src: ImageData, p: DuotoneParams): ImageData {
    const [sr, sg, sb] = parseColor(p.shadowColor);
    const [mr, mg, mb] = parseColor(p.midtoneColor);
    const [hr, hg, hb] = parseColor(p.highlightColor);
    const c = clamp(p.contrast, 1, 300);
    const g = clamp(p.gamma, 0.1, 5);
    const blend = clamp(p.blend, 0, 100) / 100;
    // Three-stop gradient sampled through contrast + gamma.
    const lutR = buildLut((v) => {
        let t = clamp((v - 128) * (c / 100) + 128, 0, 255) / 255;
        t = Math.pow(t, 1 / g);
        const a = t < 0.5 ? t * 2 : 1;
        const b = t < 0.5 ? 0 : (t - 0.5) * 2;
        return t < 0.5 ? sr + (mr - sr) * a : mr + (hr - mr) * b;
    });
    const lutG = buildLut((v) => {
        let t = clamp((v - 128) * (c / 100) + 128, 0, 255) / 255;
        t = Math.pow(t, 1 / g);
        const a = t < 0.5 ? t * 2 : 1;
        const b = t < 0.5 ? 0 : (t - 0.5) * 2;
        return t < 0.5 ? sg + (mg - sg) * a : mg + (hg - mg) * b;
    });
    const lutB = buildLut((v) => {
        let t = clamp((v - 128) * (c / 100) + 128, 0, 255) / 255;
        t = Math.pow(t, 1 / g);
        const a = t < 0.5 ? t * 2 : 1;
        const b = t < 0.5 ? 0 : (t - 0.5) * 2;
        return t < 0.5 ? sb + (mb - sb) * a : mb + (hb - mb) * b;
    });
    const mapped = applyLut(src, { r: lutR, g: lutG, b: lutB });
    if (blend >= 1) {
        return mapped;
    }
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    const md = mapped.data;
    for (let i = 0; i < s.length; i += 4) {
        d[i] = s[i] + (md[i] - s[i]) * blend;
        d[i + 1] = s[i + 1] + (md[i + 1] - s[i + 1]) * blend;
        d[i + 2] = s[i + 2] + (md[i + 2] - s[i + 2]) * blend;
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Warm/cool temperature (-100..100) and green/magenta tint (-100..100). */
export function temperatureTint(src: ImageData, temperature: number, tint: number): ImageData {
    const t = clamp(temperature, -100, 100) / 100;
    const g = clamp(tint, -100, 100) / 100;
    const dr = t * 32;
    const dg = g * 24;
    const db = -t * 32;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        d[i] = clamp255(s[i] + dr);
        d[i + 1] = clamp255(s[i + 1] - dg);
        d[i + 2] = clamp255(s[i + 2] + db);
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Tints shadows and highlights independently; balance shifts the split. */
export function splitToning(
    src: ImageData,
    shadowTint: string,
    highlightTint: string,
    strength: number,
    balance: number
): ImageData {
    const [sr, sg, sb] = parseColor(shadowTint);
    const [hr, hg, hb] = parseColor(highlightTint);
    const amt = clamp(strength, 0, 100) / 100;
    const split = clamp(128 + (balance / 100) * 96, 32, 224);
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const lum = luminance(s[i], s[i + 1], s[i + 2]);
        const shadowW = lum < split ? 1 - lum / split : 0;
        const highW = lum > split ? (lum - split) / (255 - split) : 0;
        const r = s[i] + (sr - s[i]) * shadowW * amt + (hr - s[i]) * highW * amt;
        const g = s[i + 1] + (sg - s[i + 1]) * shadowW * amt + (hg - s[i + 1]) * highW * amt;
        const b = s[i + 2] + (sb - s[i + 2]) * shadowW * amt + (hb - s[i + 2]) * highW * amt;
        d[i] = clamp255(r);
        d[i + 1] = clamp255(g);
        d[i + 2] = clamp255(b);
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Lifts/darkens shadows and highlights (-100..100 each). */
export function shadowsHighlights(src: ImageData, shadows: number, highlights: number): ImageData {
    const sh = clamp(shadows, -100, 100) / 100;
    const hi = clamp(highlights, -100, 100) / 100;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
        const sw = (1 - lum) * (1 - lum);
        const hw = lum * lum;
        const f = 1 + sh * sw * 0.6 + hi * hw * 0.6;
        d[i] = clamp255(s[i] * f);
        d[i + 1] = clamp255(s[i + 1] * f);
        d[i + 2] = clamp255(s[i + 2] * f);
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Replaces pixels within RGB tolerance of a target colour. */
export function replaceColor(
    src: ImageData,
    targetColor: string,
    replacementColor: string,
    tolerance: number
): ImageData {
    const [tr, tg, tb] = parseColor(targetColor);
    const [rr, rg, rb] = parseColor(replacementColor);
    const limit = (clamp(tolerance, 0, 100) / 100) * 441.67;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    const limitSq = limit * limit;
    for (let i = 0; i < s.length; i += 4) {
        const dr = s[i] - tr;
        const dg = s[i + 1] - tg;
        const db = s[i + 2] - tb;
        const distSq = dr * dr + dg * dg + db * db;
        if (distSq <= limitSq) {
            const t = 1 - Math.sqrt(distSq) / (limit || 1);
            const k = 0.35 + 0.65 * (t > 1 ? 1 : t);
            d[i] = clamp255(s[i] + (rr - s[i]) * k);
            d[i + 1] = clamp255(s[i + 1] + (rg - s[i + 1]) * k);
            d[i + 2] = clamp255(s[i + 2] + (rb - s[i + 2]) * k);
        } else {
            d[i] = s[i];
            d[i + 1] = s[i + 1];
            d[i + 2] = s[i + 2];
        }
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Per-channel histogram stretch ignoring a clip percentage at both ends. */
export function autoContrast(src: ImageData, clipPercent = 0): ImageData {
    const w = src.width;
    const h = src.height;
    const total = w * h;
    const clip = Math.floor((clamp(clipPercent, 0, 49) / 100) * total);
    const hist = new Uint32Array(256);
    const s = src.data;
    const luts: Lut[] = [];
    for (let c = 0; c < 3; c++) {
        hist.fill(0);
        for (let i = c; i < s.length; i += 4) {
            hist[s[i]]++;
        }
        let low = 0;
        let high = 255;
        let acc = 0;
        for (let v = 0; v < 256; v++) {
            acc += hist[v];
            if (acc > clip) {
                low = v;
                break;
            }
        }
        acc = 0;
        for (let v = 255; v >= 0; v--) {
            acc += hist[v];
            if (acc > clip) {
                high = v;
                break;
            }
        }
        if (high <= low) {
            high = low + 1;
        }
        const lo = low;
        const span = high - low;
        luts.push(buildLut((v) => ((v - lo) / span) * 255));
    }
    return applyLut(src, { r: luts[0], g: luts[1], b: luts[2] });
}
