/**
 * ShareX "Adjustments" category — 32 native pixel effects.
 *
 * Tier A ports follow the C# reference formulas exactly (colour matrices,
 * lookup curves, per-pixel loops). Tier B approximations (`clarity`, `dehaze`)
 * use the shared algorithm library and are documented at their definitions.
 *
 * Every implementation is pure: the input ImageData is never mutated, alpha is
 * preserved and a fresh buffer is always returned.
 */
import {
    boxBlur,
} from "../ops/kernels.ts";
import {
    alphaAmount,
    applyColorMatrix,
    autoContrast,
    brightness,
    channelSwap,
    colorBalance,
    colorize,
    contrast,
    duotone,
    exposure,
    gamma,
    grayscale,
    hueRotate,
    identityColorMatrix,
    invert,
    levels,
    posterize,
    saturation,
    sepia,
    shadowsHighlights,
    solarize,
    splitToning,
    temperatureTint,
    threshold,
    vibrance,
} from "../ops/color.ts";
import type { ChannelSwapMode } from "../ops/color.ts";
import {
    clamp,
    clamp255,
    cloneImageData,
    makeImageData,
    parseColor,
} from "../pixels.ts";
import type { EffectImpl, EffectRegistry, ParamDict } from "../types.ts";

/** Defensive numeric getter (params are normally pre-clamped by the catalog). */
function num(params: ParamDict, key: string, fallback: number): number {
    const raw = params[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

/** Defensive string getter for enum / colour parameters. */
function text(params: ParamDict, key: string, fallback: string): string {
    const raw = params[key];
    return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

/** Drops the alpha row/column offsets of a 4x5 matrix into byte units. */
function scaleMatrixOffsets(matrix: number[]): number[] {
    const out = matrix.slice();
    for (let i = 4; i < 20; i += 5) {
        out[i] *= 255;
    }
    return out;
}

/** Linear blend between the identity matrix and a target matrix. */
function blendMatrix(target: number[], strength: number): number[] {
    const identity = identityColorMatrix();
    const out = new Array<number>(20);
    for (let i = 0; i < 20; i++) {
        out[i] = identity[i] * (1 - strength) + target[i] * strength;
    }
    return out;
}

const CHANNEL_SWAP_MODES: ChannelSwapMode[] = [
    "RedGreen",
    "RedBlue",
    "GreenBlue",
    "RotateRGB",
    "RotateBGR",
];

function channelSwapMode(params: ParamDict): ChannelSwapMode {
    const value = text(params, "mode", "RedGreen");
    return CHANNEL_SWAP_MODES.includes(value as ChannelSwapMode)
        ? (value as ChannelSwapMode)
        : "RedGreen";
}

/* ------------------------------------------------------------------ */
/* Tier A ports                                                        */
/* ------------------------------------------------------------------ */

const alphaEffect: EffectImpl = (src, params) =>
    alphaAmount(src, num(params, "amount", 100));

const autoContrastEffect: EffectImpl = (src, params) =>
    autoContrast(src, num(params, "clip_percent", 0.5));

/** Hard luminance cut at 127 using Rec.709 weights (ShareX Black & White). */
const blackAndWhiteEffect: EffectImpl = (src) => {
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const lum = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2];
        const v = lum > 127 ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = s[i + 3];
    }
    return out;
};

const brightnessEffect: EffectImpl = (src, params) =>
    brightness(src, num(params, "amount", 0));

const channelSwapEffect: EffectImpl = (src, params) =>
    channelSwap(src, channelSwapMode(params));

const colorBalanceEffect: EffectImpl = (src, params) =>
    colorBalance(src, {
        shadowCyanRed: num(params, "shadow_cyan_red", 0),
        shadowMagentaGreen: num(params, "shadow_magenta_green", 0),
        shadowYellowBlue: num(params, "shadow_yellow_blue", 0),
        midCyanRed: num(params, "mid_cyan_red", 0),
        midMagentaGreen: num(params, "mid_magenta_green", 0),
        midYellowBlue: num(params, "mid_yellow_blue", 0),
        highlightCyanRed: num(params, "highlight_cyan_red", 0),
        highlightMagentaGreen: num(params, "highlight_magenta_green", 0),
        highlightYellowBlue: num(params, "highlight_yellow_blue", 0),
    });

/** 20 numeric params in row-major order: rows r, g, b, a; offsets in 0..255. */
const colorMatrixEffect: EffectImpl = (src, params) => {
    const keys = [
        "rr", "rg", "rb", "ra", "ro",
        "gr", "gg", "gb", "ga", "go",
        "br", "bg", "bb", "ba", "bo",
        "ar", "ag", "ab", "aa", "ao",
    ];
    const defaults = [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
    ];
    const matrix = keys.map((key, index) => num(params, key, defaults[index]));
    return applyColorMatrix(src, matrix);
};

const colorizeEffect: EffectImpl = (src, params) =>
    colorize(
        src,
        text(params, "color", "#FFA500"),
        num(params, "strength", 50)
    );

const contrastEffect: EffectImpl = (src, params) =>
    contrast(src, num(params, "amount", 0));

/** ShareX cross-process matrix (offsets 0..1 there, 0..255 here). */
const crossProcessEffect: EffectImpl = (src, params) => {
    const strength = clamp(num(params, "strength", 100), 0, 100) / 100;
    if (strength <= 0) {
        return cloneImageData(src);
    }
    const cross = [
        1.2, 0.1, -0.1, 0, 0.05,
        -0.1, 1.3, 0.0, 0, 0.02,
        -0.1, 0.0, 0.8, 0, 0.1,
        0, 0, 0, 1, 0,
    ];
    return applyColorMatrix(src, scaleMatrixOffsets(blendMatrix(cross, strength)));
};

const duotoneGradientMapEffect: EffectImpl = (src, params) =>
    duotone(src, {
        shadowColor: text(params, "shadow_color", "#181C4E"),
        midtoneColor: text(params, "midtone_color", "#B63C84"),
        highlightColor: text(params, "highlight_color", "#FFE084"),
        contrast: num(params, "contrast", 110),
        gamma: num(params, "gamma", 1),
        blend: num(params, "blend", 100),
    });

const exposureEffect: EffectImpl = (src, params) =>
    exposure(src, num(params, "amount", 0));

const gammaEffect: EffectImpl = (src, params) =>
    gamma(src, num(params, "amount", 1));

const grayscaleEffect: EffectImpl = (src, params) =>
    grayscale(src, num(params, "strength", 100));

const hueEffect: EffectImpl = (src, params) =>
    hueRotate(src, num(params, "amount", 0));

const invertEffect: EffectImpl = (src) => invert(src);

const levelsEffect: EffectImpl = (src, params) => {
    const inputBlack = Math.round(clamp(num(params, "input_black", 0), 0, 255));
    let inputWhite = Math.round(clamp(num(params, "input_white", 255), 0, 255));
    if (inputWhite <= inputBlack) {
        inputWhite = Math.min(255, inputBlack + 1);
    }
    let outputBlack = Math.round(clamp(num(params, "output_black", 0), 0, 255));
    let outputWhite = Math.round(clamp(num(params, "output_white", 255), 0, 255));
    if (outputWhite < outputBlack) {
        const swapped = outputBlack;
        outputBlack = outputWhite;
        outputWhite = swapped;
    }
    return levels(
        src,
        inputBlack,
        inputWhite,
        num(params, "gamma", 1),
        outputBlack,
        outputWhite
    );
};

/** Warm high-contrast matrix plus the radial vignette from ShareX's Lomo. */
const lomoEffect: EffectImpl = (src, params) => {
    const strength = clamp(num(params, "strength", 100), 0, 100) / 100;
    if (strength <= 0) {
        return cloneImageData(src);
    }
    const lomo = [
        1.3, 0.05, -0.05, 0, 0.02,
        -0.02, 1.1, -0.02, 0, 0.01,
        -0.05, 0.0, 0.9, 0, -0.02,
        0, 0, 0, 1, 0,
    ];
    const colored = applyColorMatrix(src, scaleMatrixOffsets(blendMatrix(lomo, strength)));
    const w = colored.width;
    const h = colored.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.sqrt(w * w + h * h) * 0.5 || 1;
    const maxAlpha = 180 * strength;
    const s = colored.data;
    const d = colored.data;
    for (let y = 0; y < h; y++) {
        const dy = y - cy;
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const t = clamp(Math.sqrt(dx * dx + dy * dy) / radius - 0.5, 0, 0.5) / 0.5;
            const shade = 1 - (maxAlpha * t) / 255;
            const i = (y * w + x) * 4;
            d[i] = clamp255(s[i] * shade);
            d[i + 1] = clamp255(s[i + 1] * shade);
            d[i + 2] = clamp255(s[i + 2] * shade);
        }
    }
    return colored;
};

const polaroidEffect: EffectImpl = (src) =>
    applyColorMatrix(src, [
        1.438, -0.062, -0.062, 0, 0,
        -0.122, 1.378, -0.122, 0, 0,
        -0.016, -0.016, 1.483, 0, 0,
        0, 0, 0, 1, 0,
    ]);

const posterizeEffect: EffectImpl = (src, params) =>
    posterize(src, num(params, "levels", 8));

/**
 * ShareX replace-colour semantics: per-channel tolerance scaled by 2.55 and a
 * hard substitution; the source alpha is kept.
 */
const replaceColorEffect: EffectImpl = (src, params) => {
    const [tr, tg, tb, ta] = parseColor(text(params, "target_color", "#FFFFFF"));
    const [rr, rg, rb] = parseColor(text(params, "replace_color", "#000000"));
    const tolerance = clamp(num(params, "tolerance", 40), 0, 255) * 2.55;
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const matched =
            Math.abs(s[i] - tr) <= tolerance &&
            Math.abs(s[i + 1] - tg) <= tolerance &&
            Math.abs(s[i + 2] - tb) <= tolerance &&
            Math.abs(s[i + 3] - ta) <= tolerance;
        d[i] = matched ? rr : s[i];
        d[i + 1] = matched ? rg : s[i + 1];
        d[i + 2] = matched ? rb : s[i + 2];
        d[i + 3] = s[i + 3];
    }
    return out;
};

const saturationEffect: EffectImpl = (src, params) =>
    saturation(src, num(params, "amount", 0));

const sepiaEffect: EffectImpl = (src, params) =>
    sepia(src, num(params, "strength", 100));

const shadowsHighlightsEffect: EffectImpl = (src, params) =>
    shadowsHighlights(
        src,
        num(params, "shadows", 0),
        num(params, "highlights", 0)
    );

const solarizeEffect: EffectImpl = (src, params) =>
    solarize(src, num(params, "threshold", 128));

const splitToningEffect: EffectImpl = (src, params) =>
    splitToning(
        src,
        text(params, "shadow_tint", "#283278"),
        text(params, "highlight_tint", "#C8AA64"),
        num(params, "strength", 30),
        num(params, "balance", 0)
    );

const temperatureTintEffect: EffectImpl = (src, params) =>
    temperatureTint(
        src,
        num(params, "temperature", 0),
        num(params, "tint", 0)
    );

const thresholdEffect: EffectImpl = (src, params) =>
    threshold(src, num(params, "value", 128));

const vibranceEffect: EffectImpl = (src, params) =>
    vibrance(src, num(params, "amount", 0));

/* ------------------------------------------------------------------ */
/* Tier B approximations                                               */
/* ------------------------------------------------------------------ */

/**
 * Clarity: unsharp mask against a wide low-pass (ShareX uses a 2% of the long
 * edge blur, minimum 3px), weighted by a midtone bell mask, then a light
 * saturation lift. A separable box blur replaces Skia's gaussian blur because
 * its cost is independent of radius; the radius is derived from env.scale.
 */
const clarityEffect: EffectImpl = (src, params, env) => {
    const amount = clamp(num(params, "amount", 0), -100, 100) / 100;
    if (Math.abs(amount) < 0.001) {
        return cloneImageData(src);
    }
    const maxSide = Math.max(src.width, src.height);
    const radius = Math.max(env.px(3), maxSide * 0.02);
    const blurred = boxBlur(src, radius);
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const b = blurred.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const sr = s[i] / 255;
        const sg = s[i + 1] / 255;
        const sb = s[i + 2] / 255;
        const lum = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const diff = lum - 0.5;
        const mask = Math.exp(-8 * diff * diff);
        const strength = amount * mask * 1.5;
        d[i] = clamp255((sr + (sr - b[i] / 255) * strength) * 255);
        d[i + 1] = clamp255((sg + (sg - b[i + 1] / 255) * strength) * 255);
        d[i + 2] = clamp255((sb + (sb - b[i + 2] / 255) * strength) * 255);
        d[i + 3] = s[i + 3];
    }
    // Light saturation lift: ±8% at full strength.
    return saturation(out, amount * 8);
};

/**
 * Dehaze: contrast / saturation / black-point approximation of ShareX's
 * dark-channel pass. Positive amounts add punch and clip the shadow veil,
 * negative amounts flatten contrast and lift blacks toward atmospheric grey.
 */
const dehazeEffect: EffectImpl = (src, params) => {
    const amount = clamp(num(params, "amount", 50), -100, 100) / 100;
    if (Math.abs(amount) < 0.001) {
        return cloneImageData(src);
    }
    if (amount > 0) {
        const sharpened = contrast(src, amount * 45);
        const saturated = saturation(sharpened, amount * 35);
        return levels(saturated, Math.round(amount * 12), 255, 1, 0, 255);
    }
    const flat = contrast(src, amount * 40);
    const muted = saturation(flat, amount * 30);
    return levels(muted, 0, 255, 1, Math.round(amount * -35), 255);
};

/* ------------------------------------------------------------------ */
/* Film emulation                                                      */
/* ------------------------------------------------------------------ */

type FilmPreset = "Classic" | "Warm" | "Cool" | "Faded" | "CrossProcessed";

const FILM_PRESETS: FilmPreset[] = [
    "Classic",
    "Warm",
    "Cool",
    "Faded",
    "CrossProcessed",
];

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function filmPresetTone(
    preset: FilmPreset,
    r: number,
    g: number,
    b: number
): [number, number, number] {
    switch (preset) {
        case "Warm": {
            const tr = r * 1.1 + g * 0.015;
            const tg = g * 1.04;
            const tb = b * 0.88 + r * 0.01;
            return [clamp01(tr), clamp01(tg), clamp01(tb)];
        }
        case "Cool": {
            const tr = r * 0.94 + b * 0.02;
            const tg = g * 1.01 + b * 0.01;
            const tb = b * 1.1 + g * 0.01;
            return [clamp01(tr), clamp01(tg), clamp01(tb)];
        }
        case "Faded": {
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            return [
                clamp01(lerp(r, lum + 0.04, 0.22)),
                clamp01(lerp(g, lum + 0.03, 0.18)),
                clamp01(lerp(b, lum - 0.01, 0.26)),
            ];
        }
        case "CrossProcessed": {
            const tr = Math.pow(Math.max(r, 0.0001), 0.88) * 1.08;
            const tg = Math.pow(Math.max(g, 0.0001), 1.05) * 0.98;
            const tb = Math.pow(Math.max(b, 0.0001), 0.82) * 1.12;
            return [clamp01(tr), clamp01(tg), clamp01(tb)];
        }
        default: {
            const tr = r * 1.05 + g * 0.02;
            const tg = g * 1.02 + r * 0.01;
            const tb = b * 0.94 + g * 0.02;
            return [clamp01(tr), clamp01(tg), clamp01(tb)];
        }
    }
}

/** Deterministic per-pixel white noise in [0,1) keyed by position + salt. */
function grain01(x: number, y: number, salt: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + salt) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/**
 * Film emulation: per preset tone mapping, contrast around mid-grey, a fade
 * (reduced slope + black lift) and seeded monochrome-ish grain. Grain salts
 * come from env.rand so previews are reproducible.
 */
const filmEmulationEffect: EffectImpl = (src, params, env) => {
    const presetValue = text(params, "preset", "Classic");
    const preset = FILM_PRESETS.includes(presetValue as FilmPreset)
        ? (presetValue as FilmPreset)
        : "Classic";
    const toneStrength = clamp(num(params, "tone_strength", 65), 0, 100) / 100;
    const grain = clamp(num(params, "grain_amount", 12), 0, 100) / 100;
    const fade = clamp(num(params, "fade_amount", 10), 0, 100) / 100;
    const contrastAmount =
        clamp(num(params, "contrast_amount", 110), 50, 150) / 100;

    if (
        toneStrength <= 0 &&
        grain <= 0 &&
        fade <= 0 &&
        Math.abs(contrastAmount - 1) < 0.0001
    ) {
        return cloneImageData(src);
    }

    const grainAmp = grain * 0.1;
    const salt0 = grain > 0 ? Math.floor(env.rand() * 0x7fffffff) : 0;
    const salt1 = grain > 0 ? Math.floor(env.rand() * 0x7fffffff) : 0;
    const salt2 = grain > 0 ? Math.floor(env.rand() * 0x7fffffff) : 0;

    const fadeScale = 1 - fade * 0.35;
    const blackLift = fade * 0.06;
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const s = src.data;
    const d = out.data;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const sr = s[i] / 255;
            const sg = s[i + 1] / 255;
            const sb = s[i + 2] / 255;

            const [tr, tg, tb] = filmPresetTone(preset, sr, sg, sb);

            let r = lerp(sr, tr, toneStrength);
            let g = lerp(sg, tg, toneStrength);
            let b = lerp(sb, tb, toneStrength);

            r = (r - 0.5) * contrastAmount + 0.5;
            g = (g - 0.5) * contrastAmount + 0.5;
            b = (b - 0.5) * contrastAmount + 0.5;

            r = r * fadeScale + blackLift;
            g = g * fadeScale + blackLift;
            b = b * fadeScale + blackLift;

            if (grain > 0) {
                r += (grain01(x, y, salt0) * 2 - 1) * grainAmp;
                g += (grain01(x, y, salt1) * 2 - 1) * grainAmp;
                b += (grain01(x, y, salt2) * 2 - 1) * grainAmp;
            }

            d[i] = clamp255(clamp01(r) * 255);
            d[i + 1] = clamp255(clamp01(g) * 255);
            d[i + 2] = clamp255(clamp01(b) * 255);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const ADJUSTMENT_IMPLS: EffectRegistry = {
    alpha: alphaEffect,
    auto_contrast: autoContrastEffect,
    black_and_white: blackAndWhiteEffect,
    brightness: brightnessEffect,
    channel_swap: channelSwapEffect,
    clarity: clarityEffect,
    color_balance: colorBalanceEffect,
    color_matrix: colorMatrixEffect,
    colorize: colorizeEffect,
    contrast: contrastEffect,
    cross_process: crossProcessEffect,
    dehaze: dehazeEffect,
    duotone_gradient_map: duotoneGradientMapEffect,
    exposure: exposureEffect,
    film_emulation: filmEmulationEffect,
    gamma: gammaEffect,
    grayscale: grayscaleEffect,
    hue: hueEffect,
    invert: invertEffect,
    levels: levelsEffect,
    lomo: lomoEffect,
    polaroid: polaroidEffect,
    posterize: posterizeEffect,
    replace_color: replaceColorEffect,
    saturation: saturationEffect,
    sepia: sepiaEffect,
    shadows_highlights: shadowsHighlightsEffect,
    solarize: solarizeEffect,
    split_toning: splitToningEffect,
    temperature_tint: temperatureTintEffect,
    threshold: thresholdEffect,
    vibrance: vibranceEffect,
};

/** Frame ids of this batch (adjustments never expand the canvas). */
export const ADJUSTMENT_FRAME_IDS: string[] = [];
