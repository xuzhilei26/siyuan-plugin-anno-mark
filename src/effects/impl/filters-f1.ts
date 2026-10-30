/**
 * F1 filter effects — core pixel / convolution batch (47 ids).
 *
 * Ports ShareX.ImageEditor `Filters/*` onto the shared ops library. Spatial
 * parameters (radius, size, distance, spacing, cell size, width…) are scaled
 * with `env.px()` so preview and export match; 0..100 amounts are not scaled.
 * Noise-based effects are seeded deterministically per effect instance.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    luminance,
    makeImageData,
    smoothstep,
} from "../pixels.ts";
import { deriveSeed, mulberry32 } from "../rand.ts";
import type { EffectImpl, EffectRegistry, ParamDict } from "../types.ts";
import {
    bevel,
    boxBlur,
    colorDepth,
    colorHalftone,
    convolve,
    dithering,
    dotMatrix,
    edgeDetect,
    edgeFeather,
    emboss,
    gaussianBlur,
    halftone,
    lensBlur,
    meanRemoval,
    medianFilter,
    mosaicPolygon,
    motionBlur,
    outline,
    paletteMap,
    pixelate,
    pixelateShape,
    sampleBilinear,
    scanlines,
    sharpen,
    sobelEdge,
    spinBlur,
    surfaceBlur,
    unsharpMask,
    vignette,
    voronoiMosaic,
    zoomBlur,
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

/** Scales a pixel-unit value to the current render resolution. */
function pxCell(env: { px(value: number): number }, value: number, min = 1): number {
    return Math.max(min, Math.round(env.px(value)));
}

// --------------------------------------------------------------- pixel utils

function hash01(x: number, y: number, seed: number): number {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** Bilinear resample back into `width` × `height` (used to keep frame size). */
function fitToSize(src: ImageData, width: number, height: number): ImageData {
    const out = makeImageData(width, height);
    const px = new Float32Array(4);
    const sxScale = src.width / width;
    const syScale = src.height / height;
    for (let y = 0; y < height; y++) {
        const sy = (y + 0.5) * syScale - 0.5;
        for (let x = 0; x < width; x++) {
            const sx = (x + 0.5) * sxScale - 0.5;
            sampleBilinear(src, sx, sy, px);
            const i = (y * width + x) * 4;
            const d = out.data;
            d[i] = clamp255(px[0]);
            d[i + 1] = clamp255(px[1]);
            d[i + 2] = clamp255(px[2]);
            d[i + 3] = clamp255(px[3]);
        }
    }
    return out;
}

/** Separable box blur restricted to the alpha channel (mutates `img`). */
function blurAlpha(img: ImageData, radius: number): void {
    const r = Math.round(radius);
    if (r < 1) {
        return;
    }
    const w = img.width;
    const h = img.height;
    const data = img.data;
    const field = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        field[p] = data[i + 3];
    }
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0;
            let n = 0;
            for (let k = -r; k <= r; k++) {
                const xx = x + k;
                if (xx >= 0 && xx < w) {
                    sum += field[y * w + xx];
                    n++;
                }
            }
            tmp[y * w + x] = sum / n;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0;
            let n = 0;
            for (let k = -r; k <= r; k++) {
                const yy = y + k;
                if (yy >= 0 && yy < h) {
                    sum += tmp[yy * w + x];
                    n++;
                }
            }
            data[(y * w + x) * 4 + 3] = sum / n;
        }
    }
}

function lerpStops(stops: Array<[number, RGB]>, t: number): RGB {
    const first = stops[0];
    const last = stops[stops.length - 1];
    let a = first;
    let b = last;
    for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i][0] && t <= stops[i + 1][0]) {
            a = stops[i];
            b = stops[i + 1];
            break;
        }
    }
    const span = b[0] - a[0] || 1;
    const k = clamp((t - a[0]) / span, 0, 1);
    return [
        a[1][0] + (b[1][0] - a[1][0]) * k,
        a[1][1] + (b[1][1] - a[1][1]) * k,
        a[1][2] + (b[1][2] - a[1][2]) * k,
    ];
}

function gradientLut(stops: Array<[number, RGB]>): Uint8ClampedArray {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let v = 0; v < 256; v++) {
        const rgb = lerpStops(stops, v / 255);
        lut[v * 3] = rgb[0];
        lut[v * 3 + 1] = rgb[1];
        lut[v * 3 + 2] = rgb[2];
    }
    return lut;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const mx = Math.max(rn, Math.max(gn, bn));
    const mn = Math.min(rn, Math.min(gn, bn));
    const l = (mx + mn) * 0.5;
    const delta = mx - mn;
    let h = 0;
    let s = 0;
    if (delta > 0.00001) {
        s = l > 0.5 ? delta / (2 - mx - mn) : delta / (mx + mn);
        if (mx === rn) {
            h = ((gn - bn) / delta) % 6;
        } else if (mx === gn) {
            h = (bn - rn) / delta + 2;
        } else {
            h = (rn - gn) / delta + 4;
        }
        h *= 60;
        if (h < 0) {
            h += 360;
        }
    }
    return [h, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): RGB {
    const hue = ((h % 360) + 360) % 360;
    const sn = clamp(s, 0, 100) / 100;
    const ln = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const hp = hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;
    if (hp < 1) {
        r = c;
        g = x;
    } else if (hp < 2) {
        r = x;
        g = c;
    } else if (hp < 3) {
        g = c;
        b = x;
    } else if (hp < 4) {
        g = x;
        b = c;
    } else if (hp < 5) {
        r = x;
        b = c;
    } else {
        r = c;
        b = x;
    }
    const m = ln - c * 0.5;
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function screenBlend(base: number, amount: number): number {
    return 1 - (1 - base) * (1 - amount);
}

// ------------------------------------------------------------ gradient stops

const HEAT_STOPS: Array<[number, RGB]> = [
    [0, [0, 0, 0]],
    [0.2, [0, 0, 255]],
    [0.4, [0, 255, 255]],
    [0.6, [0, 255, 0]],
    [0.8, [255, 255, 0]],
    [1, [255, 0, 255]],
];

const THERMAL_STOPS: Array<[number, RGB]> = [
    [0, [0, 0, 52]],
    [0.2, [0, 34, 170]],
    [0.4, [0, 160, 255]],
    [0.6, [0, 255, 210]],
    [0.76, [255, 255, 0]],
    [0.9, [255, 80, 0]],
    [1, [255, 255, 255]],
];

const HEAT_LUT = gradientLut(HEAT_STOPS);
const THERMAL_LUT = gradientLut(THERMAL_STOPS);

// ------------------------------------------------------------------- effects

const blur: EffectImpl = (src, p, env) => boxBlur(src, env.px(num(p, "radius", 10)));

const gaussianBlurImpl: EffectImpl = (src, p, env) =>
    gaussianBlur(src, env.px(num(p, "radius", 15)));

const meanRemovalImpl: EffectImpl = (src) => meanRemoval(src);

const medianFilterImpl: EffectImpl = (src, p, env) =>
    medianFilter(src, Math.max(1, Math.round(env.px(num(p, "radius", 1)))));

const motionBlurImpl: EffectImpl = (src, p, env) =>
    motionBlur(src, env.px(num(p, "distance", 12)), num(p, "angle", 0));

const spinBlurImpl: EffectImpl = (src, p) =>
    spinBlur(
        src,
        num(p, "angle", 20),
        num(p, "samples", 24),
        num(p, "center_x", 50),
        num(p, "center_y", 50)
    );

const zoomBlurImpl: EffectImpl = (src, p) =>
    zoomBlur(
        src,
        num(p, "strength", 35),
        num(p, "samples", 24),
        num(p, "center_x", 50),
        num(p, "center_y", 50)
    );

const lensBlurImpl: EffectImpl = (src, p, env) =>
    lensBlur(
        src,
        env.px(num(p, "radius", 8)),
        (clamp(num(p, "highlight_threshold", 70), 0, 100) / 100) * 255,
        clamp(num(p, "highlight_boost", 85), 0, 100)
    );

const surfaceBlurImpl: EffectImpl = (src, p, env) =>
    surfaceBlur(
        src,
        Math.max(1, Math.round(env.px(num(p, "radius", 3)))),
        num(p, "threshold", 24)
    );

const sharpenImpl: EffectImpl = (src, p) => sharpen(src, num(p, "strength", 50));

const unsharpMaskImpl: EffectImpl = (src, p, env) =>
    unsharpMask(
        src,
        env.px(num(p, "radius", 5)),
        num(p, "amount", 150),
        num(p, "threshold", 0)
    );

const edgeDetectImpl: EffectImpl = (src) => edgeDetect(src);

const sobelEdgeImpl: EffectImpl = (src, p) =>
    sobelEdge(src, num(p, "strength", 1.2), num(p, "threshold", 20));

const embossImpl: EffectImpl = (src) => emboss(src);

const bevelImpl: EffectImpl = (src, p, env) =>
    bevel(
        src,
        Math.max(1, Math.round(env.px(num(p, "size", 10)))),
        num(p, "strength", 70),
        num(p, "light_angle", 225),
        strOf(p, "highlight_color", "#FFFFFFD9"),
        strOf(p, "shadow_color", "#000000B0")
    );

/**
 * Outline is authored as a frame (expands the canvas); this batch keeps the
 * output size, so the padded result is resampled back inward.
 */
const outlineImpl: EffectImpl = (src, p, env) => {
    const size = Math.max(1, Math.round(env.px(num(p, "size", 3))));
    const padding = Math.max(0, Math.round(env.px(num(p, "padding", 0))));
    const result = outline(
        src,
        size,
        padding,
        strOf(p, "color", "#000000"),
        boolOf(p, "outline_only", false)
    );
    if (result.pad.top === 0 && result.pad.right === 0 &&
        result.pad.bottom === 0 && result.pad.left === 0) {
        return result.data;
    }
    return fitToSize(result.data, src.width, src.height);
};

const convolutionMatrix: EffectImpl = (src, p) => {
    const kernel = [
        num(p, "x0y0", 0), num(p, "x1y0", 0), num(p, "x2y0", 0),
        num(p, "x0y1", 0), num(p, "x1y1", 1), num(p, "x2y1", 0),
        num(p, "x0y2", 0), num(p, "x1y2", 0), num(p, "x2y2", 0),
    ];
    const factor = num(p, "factor", 1);
    const divisor = factor === 0 ? 1 : factor;
    return convolve(src, kernel, 3, 3, divisor, num(p, "offset", 0));
};

const edgeFeatherImpl: EffectImpl = (src, p, env) =>
    edgeFeather(src, env.px(num(p, "radius", 12)));

const pixelateImpl: EffectImpl = (src, p, env) =>
    pixelate(src, pxCell(env, num(p, "size", 10), 1));

const diamondPixelate: EffectImpl = (src, p, env) =>
    pixelateShape(src, pxCell(env, num(p, "size", 16), 2), "diamond");

const hexagonalPixelate: EffectImpl = (src, p, env) =>
    pixelateShape(src, pxCell(env, num(p, "size", 16), 2), "hex");

const trianglePixelate: EffectImpl = (src, p, env) =>
    pixelateShape(src, pxCell(env, num(p, "size", 24), 2), "triangle");

const mosaicPolygonImpl: EffectImpl = (src, p, env) =>
    mosaicPolygon(
        src,
        pxCell(env, num(p, "cell_size", 24), 4),
        strOf(p, "shape", "Hexagon") === "Triangle" ? "Triangle" : "Hexagon",
        env.px(num(p, "border_width", 1)),
        num(p, "border_opacity", 45),
        num(p, "randomness", 18),
        deriveSeed(env.seed, "mosaic_polygon")
    );

const voronoiMosaicImpl: EffectImpl = (src, p, env) =>
    voronoiMosaic(
        src,
        num(p, "cell_count", 300),
        boolOf(p, "draw_edges", true),
        env.px(num(p, "edge_thickness", 1)),
        strOf(p, "edge_color", "#000000"),
        deriveSeed(env.seed, "voronoi_mosaic")
    );

const halftoneImpl: EffectImpl = (src, p, env) =>
    halftone(
        src,
        pxCell(env, num(p, "cell_size", 8), 2),
        num(p, "dot_softness", 18),
        num(p, "ink_strength", 90),
        num(p, "source_blend", 20)
    );

const colorHalftoneImpl: EffectImpl = (src, p, env) =>
    colorHalftone(src, pxCell(env, num(p, "size", 8), 2));

const dotMatrixImpl: EffectImpl = (src, p, env) =>
    dotMatrix(
        src,
        pxCell(env, num(p, "cell_size", 8), 2),
        num(p, "dot_scale", 0.85),
        boolOf(p, "color_mode", false),
        strOf(p, "dot_color", "#141414"),
        strOf(p, "paper_color", "#FAF5EB")
    );

const ditheringImpl: EffectImpl = (src, p) => {
    const paletteValue = strOf(p, "palette", "OneBitBW");
    const palette =
        paletteValue === "WebSafe216" || paletteValue === "RGB332" || paletteValue === "Grayscale4"
            ? paletteValue
            : "OneBitBW";
    const method = strOf(p, "method", "FloydSteinberg") === "Bayer4x4" ? "Bayer4x4" : "FloydSteinberg";
    return dithering(
        src,
        method,
        palette,
        boolOf(p, "serpentine", true),
        num(p, "strength", 100)
    );
};

const paletteMapImpl: EffectImpl = (src, p) => paletteMap(src, num(p, "levels", 6));

const colorDepthImpl: EffectImpl = (src, p) =>
    colorDepth(src, num(p, "bitsPerChannel", 4));

const anaglyph3d: EffectImpl = (src, p, env) => {
    const sepX = num(p, "separation_x", 10);
    const sepY = num(p, "separation_y", 0);
    if (sepX === 0 && sepY === 0) {
        return cloneImageData(src);
    }
    const halfX = env.px(sepX) * 0.5;
    const halfY = env.px(sepY) * 0.5;
    const ghost = clamp(num(p, "ghost_reduction", 45), 0, 100) / 100;
    const mode = strOf(p, "mode", "RedCyan");
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const left = new Float32Array(4);
    const right = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            sampleBilinear(src, x - halfX, y - halfY, left);
            sampleBilinear(src, x + halfX, y + halfY, right);
            const leftGray = luminance(left[0], left[1], left[2]) / 255;
            const rightGray = luminance(right[0], right[1], right[2]) / 255;
            let r: number;
            let g: number;
            let b: number;
            if (mode === "AmberBlue") {
                r = left[0] / 255 + (leftGray - left[0] / 255) * ghost * 0.85;
                g = left[1] / 255 + (leftGray - left[1] / 255) * ghost * 0.5;
                b = right[2] / 255 + (rightGray - right[2] / 255) * ghost;
            } else if (mode === "GreenMagenta") {
                r = right[0] / 255 + (rightGray - right[0] / 255) * ghost * 0.85;
                g = left[1] / 255 + (leftGray - left[1] / 255) * ghost;
                b = right[2] / 255 + (rightGray - right[2] / 255) * ghost * 0.85;
            } else {
                r = left[0] / 255 + (leftGray - left[0] / 255) * ghost;
                g = right[1] / 255 + (rightGray - right[1] / 255) * ghost * 0.9;
                b = right[2] / 255 + (rightGray - right[2] / 255) * ghost;
            }
            const i = (y * w + x) * 4;
            d[i] = clamp255(r * 255);
            d[i + 1] = clamp255(g * 255);
            d[i + 2] = clamp255(b * 255);
            d[i + 3] = (left[3] + right[3]) / 2;
        }
    }
    return out;
};

const chromaticAberration: EffectImpl = (src, p, env) => {
    const amount = env.px(clamp(num(p, "amount", 8), 0, 40));
    const strength = clamp(num(p, "strength", 75), 0, 100) / 100;
    const edgeStart = clamp(num(p, "edgeStart", 0.2), 0, 0.95);
    if (amount <= 0 || strength <= 0) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const cx = (w - 1) * 0.5;
    const cy = (h - 1) * 0.5;
    const invCx = cx > 0 ? 1 / cx : 0;
    const invCy = cy > 0 ? 1 / cy : 0;
    const sampleR = new Float32Array(4);
    const sampleB = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        const dy = (y - cy) * invCy;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const dx = (x - cx) * invCx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const radialMask = smoothstep(edgeStart, 1, dist * 0.70710678);
            if (radialMask <= 0) {
                d[i] = s[i];
                d[i + 1] = s[i + 1];
                d[i + 2] = s[i + 2];
                d[i + 3] = s[i + 3];
                continue;
            }
            const dirLength = dist > 0.0001 ? dist : 1;
            const dirX = dist > 0.0001 ? dx / dirLength : 0;
            const dirY = dist > 0.0001 ? dy / dirLength : 0;
            const mix = strength * radialMask;
            const shift = amount * radialMask;
            sampleBilinear(src, x + dirX * shift, y + dirY * shift, sampleR);
            sampleBilinear(src, x - dirX * shift, y - dirY * shift, sampleB);
            const lumDiff = Math.abs(
                luminance(sampleR[0], sampleR[1], sampleR[2]) -
                luminance(sampleB[0], sampleB[1], sampleB[2])
            );
            const splitContrast = smoothstep(2.55, 76.5, lumDiff);
            const boost = mix * (0.85 + 1.35 * splitContrast);
            const red = s[i] + (sampleR[0] - s[i]) * mix + (sampleR[0] - s[i]) * boost;
            const green =
                s[i + 1] +
                ((sampleR[1] + s[i + 1] + sampleB[1]) / 3 - s[i + 1]) * mix * 0.06;
            const blue = s[i + 2] + (sampleB[2] - s[i + 2]) * mix + (sampleB[2] - s[i + 2]) * boost;
            const alpha = s[i + 3] + ((sampleR[3] + s[i + 3] + sampleB[3]) / 3 - s[i + 3]) * mix;
            d[i] = clamp255(red);
            d[i + 1] = clamp255(green);
            d[i + 2] = clamp255(blue);
            d[i + 3] = clamp255(alpha);
        }
    }
    return out;
};

const rgbSplit: EffectImpl = (src, p, env) => {
    const rox = Math.round(env.px(num(p, "offset_red_x", -5)));
    const roy = Math.round(env.px(num(p, "offset_red_y", 0)));
    const gox = Math.round(env.px(num(p, "offset_green_x", 0)));
    const goy = Math.round(env.px(num(p, "offset_green_y", 0)));
    const box = Math.round(env.px(num(p, "offset_blue_x", 5)));
    const boy = Math.round(env.px(num(p, "offset_blue_y", 0)));
    if (rox === 0 && roy === 0 && gox === 0 && goy === 0 && box === 0 && boy === 0) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            sampleBilinear(src, x + rox, y + roy, px);
            const r = px[0];
            sampleBilinear(src, x + gox, y + goy, px);
            const g = px[1];
            sampleBilinear(src, x + box, y + boy, px);
            const b = px[2];
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const colorSplash: EffectImpl = (src, p) => {
    const targetHue = num(p, "hue", 0);
    const tolerance = num(p, "tolerance", 30);
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const [hue, sat] = rgbToHsl(s[i], s[i + 1], s[i + 2]);
        let diff = Math.abs(hue - targetHue);
        if (diff > 180) {
            diff = 360 - diff;
        }
        if (diff <= tolerance && sat > 5) {
            d[i] = s[i];
            d[i + 1] = s[i + 1];
            d[i + 2] = s[i + 2];
        } else {
            const gray = clamp255(0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2]);
            d[i] = gray;
            d[i + 1] = gray;
            d[i + 2] = gray;
        }
        d[i + 3] = s[i + 3];
    }
    return out;
};

const heatMap: EffectImpl = (src) => {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const lum = luminance(s[i], s[i + 1], s[i + 2]);
        const idx = lum | 0;
        d[i] = HEAT_LUT[idx * 3];
        d[i + 1] = HEAT_LUT[idx * 3 + 1];
        d[i + 2] = HEAT_LUT[idx * 3 + 2];
        d[i + 3] = s[i + 3];
    }
    return out;
};

const nightVision: EffectImpl = (src, p, env) => {
    const intensity = clamp(num(p, "intensity", 78), 0, 100) / 100;
    const glow = clamp(num(p, "glow", 42), 0, 100) / 100;
    const noise = clamp(num(p, "noise", 18), 0, 100) / 100;
    const vig = clamp(num(p, "vignette", 45), 0, 100) / 100;
    const scan = clamp(num(p, "scanlines", 35), 0, 100) / 100;
    if (intensity <= 0.0001) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const seed = deriveSeed(env.seed, "night_vision");
    const cx = (w - 1) * 0.5;
    const cy = (h - 1) * 0.5;
    const maxDist = Math.max(1, Math.sqrt(cx * cx + cy * cy));
    const lum = new Float32Array(w * h);
    for (let i = 0, p2 = 0; i < s.length; i += 4, p2++) {
        lum[p2] = luminance(s[i], s[i + 1], s[i + 2]) / 255;
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const v = lum[y * w + x];
            const xm = x > 0 ? x - 1 : 0;
            const xp = x + 1 < w ? x + 1 : w - 1;
            const ym = y > 0 ? y - 1 : 0;
            const yp = y + 1 < h ? y + 1 : h - 1;
            const avg =
                (v + lum[y * w + xm] + lum[y * w + xp] + lum[ym * w + x] + lum[yp * w + x]) / 5;
            let phosphor = v + (avg - v) * glow * 0.45 + Math.pow(v, 0.82) * glow * 0.26;
            phosphor *= 0.72 + intensity * 0.68;
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
            const vigMask =
                clamp(1 - vig * dist * dist, 0, 1) * (1.02 - dist * 0.08);
            const scanMask = 1 - scan * 0.16 * (0.5 + 0.5 * Math.sin(y * Math.PI));
            const grain = (hash01(x, y, seed) * 2 - 1) * noise * 0.12;
            d[i] = clamp255(clamp((phosphor * 0.12 + grain * 0.35) * vigMask * scanMask, 0, 1) * 255);
            d[i + 1] = clamp255(clamp((phosphor * 1.08 + grain) * vigMask * scanMask, 0, 1) * 255);
            d[i + 2] = clamp255(clamp((phosphor * 0.18 + grain * 0.28) * vigMask * scanMask, 0, 1) * 255);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const thermalVision: EffectImpl = (src, p) => {
    const levels = Math.round(clamp(num(p, "levels", 8), 3, 16));
    const contrast = clamp(num(p, "contrast", 135), 50, 200) / 100;
    const glow = clamp(num(p, "glow", 28), 0, 100) / 100;
    const blend = clamp(num(p, "blend", 100), 0, 100) / 100;
    const invert = boolOf(p, "invert", false);
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const steps = Math.max(1, levels - 1);
    for (let i = 0; i < s.length; i += 4) {
        let lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
        lum = clamp((lum - 0.5) * contrast + 0.5, 0, 1);
        if (invert) {
            lum = 1 - lum;
        }
        const quantized = Math.round(lum * steps) / steps;
        const idx = Math.round(quantized * 255);
        const tr = THERMAL_LUT[idx * 3];
        const tg = THERMAL_LUT[idx * 3 + 1];
        const tb = THERMAL_LUT[idx * 3 + 2];
        const glowBoost = glow * Math.pow(quantized, 2.2);
        d[i] = clamp255(s[i] + (tr + tr * glowBoost * 0.2 - s[i]) * blend);
        d[i + 1] = clamp255(s[i + 1] + (tg + tg * glowBoost * 0.25 - s[i + 1]) * blend);
        d[i + 2] = clamp255(s[i + 2] + (tb + tb * glowBoost * 0.35 - s[i + 2]) * blend);
        d[i + 3] = s[i + 3];
    }
    return out;
};

const infraredFalseColor: EffectImpl = (src, p, env) => {
    const intensity = clamp(num(p, "intensity", 68), 0, 100) / 100;
    const foliageShift = clamp(num(p, "foliage_shift", 78), 0, 100) / 100;
    const skyDarkening = clamp(num(p, "sky_darkening", 44), 0, 100) / 100;
    const glow = clamp(num(p, "glow", 20), 0, 100) / 100;
    const contrast = clamp(num(p, "contrast", 118), 50, 200) / 100;
    if (intensity <= 0.0001) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const blurred = glow > 0.01 ? gaussianBlur(src, env.px(6 + glow * 12)) : src;
    const bd = blurred.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const [hue, sat, lum] = rgbToHsl(s[i], s[i + 1], s[i + 2]);
        let nh = hue;
        let ns = sat;
        let nl = lum;
        const isFoliage = hue >= 45 && hue <= 170 && sat >= 18;
        const isSky = hue >= 170 && hue <= 260 && sat >= 12;
        if (isFoliage) {
            nh = hue + (8 + lum * 0.16 - hue) * foliageShift * (0.55 + intensity * 0.35);
            ns = Math.min(100, sat * (1 + 0.18 * intensity + 0.32 * foliageShift));
            nl = Math.min(100, lum + intensity * 14 + foliageShift * 10);
        } else if (isSky) {
            nh = hue + (196 - hue) * (0.22 + intensity * 0.28);
            ns = Math.min(100, sat * (1.03 + 0.1 * intensity));
            nl = Math.max(0, lum * (1 - skyDarkening * 0.46));
        } else {
            nh = hue + (hue + 6 - hue) * intensity * 0.1;
            ns = Math.min(100, sat * (1 + intensity * 0.06));
            nl = clamp(lum + intensity * 3, 0, 100);
        }
        const mapped = hslToRgb(nh, ns, nl);
        let r = mapped[0] / 255;
        let g = mapped[1] / 255;
        let b = mapped[2] / 255;
        r = clamp((r - 0.5) * contrast + 0.5, 0, 1);
        g = clamp((g - 0.5) * contrast + 0.5, 0, 1);
        b = clamp((b - 0.5) * contrast + 0.5, 0, 1);
        if (glow > 0.0001) {
            const glowLum = luminance(bd[i], bd[i + 1], bd[i + 2]) / 255;
            let mask = Math.max(0, (glowLum - 0.52) / 0.48);
            mask = Math.pow(mask, 1.55) * glow;
            r = screenBlend(r, mask * 0.8);
            g = screenBlend(g, mask * 0.18);
            b = screenBlend(b, mask * 0.42);
        }
        d[i] = clamp255(r * 255);
        d[i + 1] = clamp255(g * 255);
        d[i + 2] = clamp255(b * 255);
        d[i + 3] = s[i + 3];
    }
    return out;
};

/** B: border-sampled colour-key removal with soft alpha feathering. */
const removeBackground: EffectImpl = (src, p, env) => {
    const sensitivity = clamp(num(p, "sensitivity", 60), 0, 100) / 100;
    const protection = clamp(num(p, "center_protection", 65), 0, 100) / 100;
    const feather = env.px(clamp(num(p, "edge_feather", 4), 0, 24));
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = cloneImageData(src);
    const d = out.data;
    const band = Math.max(1, Math.min(24, Math.round(Math.min(w, h) * 0.08)));
    // Background prototypes from the four border bands (corner clusters).
    const protos: RGB[] = [];
    const regions: Array<[number, number, number, number]> = [
        [0, 0, band, band],
        [w - band, 0, w, band],
        [0, h - band, band, h],
        [w - band, h - band, w, h],
        [Math.floor(w / 2 - band / 2), 0, Math.floor(w / 2 + band / 2), band],
        [Math.floor(w / 2 - band / 2), h - band, Math.floor(w / 2 + band / 2), h],
    ];
    for (const region of regions) {
        const x0 = Math.max(0, region[0]);
        const y0 = Math.max(0, region[1]);
        const x1 = Math.min(w, region[2]);
        const y1 = Math.min(h, region[3]);
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * w + x) * 4;
                if (s[i + 3] <= 20) {
                    continue;
                }
                sr += s[i];
                sg += s[i + 1];
                sb += s[i + 2];
                n++;
            }
        }
        if (n > 0) {
            protos.push([sr / n, sg / n, sb / n]);
        }
    }
    if (protos.length === 0) {
        return out;
    }
    const lo = 0.04 + sensitivity * 0.3;
    const hi = lo + 0.1;
    const cx = (w - 1) * 0.5;
    const cy = (h - 1) * 0.5;
    const halfW = Math.max(1, w * 0.5);
    const halfH = Math.max(1, h * 0.5);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            let best = 0;
            for (let k = 0; k < protos.length; k++) {
                const proto = protos[k];
                const dr = s[i] - proto[0];
                const dg = s[i + 1] - proto[1];
                const db = s[i + 2] - proto[2];
                const dist = Math.sqrt(dr * dr + dg * dg + db * db);
                if (k === 0 || dist < best) {
                    best = dist;
                }
            }
            const distNorm = best / 441.67;
            let bg = 1 - smoothstep(lo, hi, distNorm);
            const dx = (x - cx) / halfW;
            const dy = (y - cy) / halfH;
            const centerDist = Math.sqrt(dx * dx + dy * dy);
            const centerMask = 1 - smoothstep(0.25, 1, centerDist);
            bg *= 1 - centerMask * protection * 0.9;
            d[i + 3] = clamp255(s[i + 3] * (1 - bg));
        }
    }
    blurAlpha(out, feather);
    return out;
};

const addNoise: EffectImpl = (src, p, env) => {
    const amplitude = Math.round(clamp(num(p, "amount", 8), 0, 100) * 1.27);
    if (amplitude <= 0) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const seed = deriveSeed(env.seed, "add_noise");
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const nr = (hash01(x, y, seed) - 0.5) * 2 * amplitude;
            const ng = (hash01(x + 17, y + 3, seed + 101) - 0.5) * 2 * amplitude;
            const nb = (hash01(x + 5, y + 29, seed + 211) - 0.5) * 2 * amplitude;
            d[i] = clamp255(s[i] + nr);
            d[i + 1] = clamp255(s[i + 1] + ng);
            d[i + 2] = clamp255(s[i + 2] + nb);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const tvStatic: EffectImpl = (src, p, env) => {
    const blend = clamp(num(p, "amount", 40) / 100, 0, 1);
    if (blend <= 0) {
        return cloneImageData(src);
    }
    const rand = mulberry32(deriveSeed(env.seed, "tv_static"));
    const s = src.data;
    const out = makeImageData(src.width, src.height);
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const noise = rand() * 255;
        d[i] = clamp255(s[i] + (noise - s[i]) * blend);
        d[i + 1] = clamp255(s[i + 1] + (noise - s[i + 1]) * blend);
        d[i + 2] = clamp255(s[i + 2] + (noise - s[i + 2]) * blend);
        d[i + 3] = s[i + 3];
    }
    return out;
};

const scanlineImpl: EffectImpl = (src, p, env) =>
    scanlines(src, pxCell(env, num(p, "spacing", 4), 2), num(p, "opacity", 50));

const vignetteImpl: EffectImpl = (src, p) =>
    vignette(src, num(p, "strength", 0.5), num(p, "radius", 0.75));

/** Band-wise horizontal displacement; canvas size is preserved (clamped). */
const sliceImpl: EffectImpl = (src, p, env) => {
    const minH = Math.max(1, Math.round(env.px(num(p, "min_height", 10))));
    const maxH = Math.max(minH, Math.round(env.px(num(p, "max_height", 100))));
    const minS = Math.max(0, Math.round(env.px(num(p, "min_shift", 0))));
    const maxS = Math.max(minS, Math.round(env.px(num(p, "max_shift", 10))));
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const rand = mulberry32(deriveSeed(env.seed, "slice"));
    const limit = Math.max(0, Math.floor(w / 2));
    let y = 0;
    while (y < h) {
        const band = Math.min(h - y, minH + Math.floor(rand() * (maxH - minH + 1)));
        const magnitude = minS + Math.round(rand() * (maxS - minS));
        const shift = Math.max(-limit, Math.min(limit, rand() < 0.5 ? -magnitude : magnitude));
        for (let yy = y; yy < y + band; yy++) {
            for (let x = 0; x < w; x++) {
                const sx = Math.max(0, Math.min(w - 1, x - shift));
                const i = (yy * w + x) * 4;
                const si = (yy * w + sx) * 4;
                d[i] = s[si];
                d[i + 1] = s[si + 1];
                d[i + 2] = s[si + 2];
                d[i + 3] = s[si + 3];
            }
        }
        y += band;
    }
    return out;
};

/** Bilateral-ish smoothing with fixed defaults (radius 3, threshold 24). */
const smoothImpl: EffectImpl = (src, p, env) =>
    surfaceBlur(src, Math.max(1, Math.round(env.px(3))), 24);

const retroSunset: EffectImpl = (src, p) => {
    const strength = clamp(num(p, "strength", 50), 0, 100) / 100;
    if (strength <= 0) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const lines = boolOf(p, "horizontal_lines", true);
    const stops: Array<[number, RGB]> = [
        [0, [120, 0, 180]],
        [0.33, [220, 20, 80]],
        [0.66, [255, 100, 0]],
        [1, [255, 200, 0]],
    ];
    const gradientAlpha = (200 / 255) * strength;
    const sunX = w * 0.5;
    const sunY = h * 0.72;
    const sunR = Math.max(1, Math.min(w, h) * 0.26);
    const lineGap = Math.max(3, Math.round(h / 80));
    const lineAmount = (60 / 255) * strength;
    for (let y = 0; y < h; y++) {
        const t = h > 1 ? y / (h - 1) : 0;
        const grad = lerpStops(stops, t);
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                const base = s[i + c] / 255;
                const g = grad[c] / 255;
                const over = base < 0.5 ? 2 * base * g : 1 - 2 * (1 - base) * (1 - g);
                d[i + c] = clamp255(s[i + c] + (over * 255 - s[i + c]) * gradientAlpha);
            }
            const dx = (x - sunX) / sunR;
            const dy = (y - sunY) / sunR;
            const dd = dx * dx + dy * dy;
            if (dd < 1) {
                const sun = (1 - dd) * gradientAlpha * 0.9;
                d[i] = clamp255(d[i] + (255 - d[i]) * sun);
                d[i + 1] = clamp255(d[i + 1] + (232 - d[i + 1]) * sun);
                d[i + 2] = clamp255(d[i + 2] + (130 - d[i + 2]) * sun);
            }
            if (lines && y % lineGap === 0) {
                d[i] = clamp255(d[i] * (1 - lineAmount));
                d[i + 1] = clamp255(d[i + 1] * (1 - lineAmount));
                d[i + 2] = clamp255(d[i + 2] * (1 - lineAmount));
            }
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

const tiltShift: EffectImpl = (src, p, env) => {
    const radial = strOf(p, "mode", "Linear") === "Radial";
    const blurRadius = env.px(clamp(num(p, "blur_radius", 12), 0, 30));
    const focusSize = clamp(num(p, "focus_size", 30), 5, 90) / 100;
    const focusX = clamp(num(p, "focus_position_x", 50), 0, 100) / 100;
    const focusY = clamp(num(p, "focus_position_y", 50), 0, 100) / 100;
    const falloff = clamp(num(p, "falloff", 24), 1, 60) / 100;
    const satBoost = clamp(num(p, "saturation_boost", 35), 0, 100) / 100;
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const blurred = blurRadius > 0.5 ? gaussianBlur(src, blurRadius) : src;
    const bd = blurred.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const cx = focusX * (w - 1);
    const cy = focusY * (h - 1);
    const minDim = Math.min(w, h);
    const focusHalfLinear = h * focusSize * 0.5;
    const focusRadiusRadial = minDim * focusSize * 0.5;
    const falloffLinear = Math.max(1, h * falloff);
    const falloffRadial = Math.max(1, minDim * falloff);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let mask: number;
            if (radial) {
                const dx = x - cx;
                const dy = y - cy;
                mask = smoothstep(focusRadiusRadial, focusRadiusRadial + falloffRadial, Math.sqrt(dx * dx + dy * dy));
            } else {
                mask = smoothstep(focusHalfLinear, focusHalfLinear + falloffLinear, Math.abs(y - cy));
            }
            const i = (y * w + x) * 4;
            let r = s[i] + (bd[i] - s[i]) * mask;
            let g = s[i + 1] + (bd[i + 1] - s[i + 1]) * mask;
            let b = s[i + 2] + (bd[i + 2] - s[i + 2]) * mask;
            const localSat = satBoost * (1 - mask * 0.7);
            if (localSat > 0) {
                const gray = (r + g + b) / 3;
                const factor = 1 + localSat;
                r = gray + (r - gray) * factor;
                g = gray + (g - gray) * factor;
                b = gray + (b - gray) * factor;
            }
            d[i] = clamp255(r);
            d[i + 1] = clamp255(g);
            d[i + 2] = clamp255(b);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
};

export const FILTER_F1_IMPLS: EffectRegistry = {
    blur,
    gaussian_blur: gaussianBlurImpl,
    mean_removal: meanRemovalImpl,
    median_filter: medianFilterImpl,
    motion_blur: motionBlurImpl,
    spin_blur: spinBlurImpl,
    zoom_blur: zoomBlurImpl,
    lens_blur: lensBlurImpl,
    surface_blur: surfaceBlurImpl,
    sharpen: sharpenImpl,
    unsharp_mask: unsharpMaskImpl,
    edge_detect: edgeDetectImpl,
    sobel_edge: sobelEdgeImpl,
    emboss: embossImpl,
    bevel: bevelImpl,
    outline: outlineImpl,
    convolution_matrix: convolutionMatrix,
    edge_feather: edgeFeatherImpl,
    pixelate: pixelateImpl,
    diamond_pixelate: diamondPixelate,
    hexagonal_pixelate: hexagonalPixelate,
    triangle_pixelate: trianglePixelate,
    mosaic_polygon: mosaicPolygonImpl,
    voronoi_mosaic: voronoiMosaicImpl,
    halftone: halftoneImpl,
    color_halftone: colorHalftoneImpl,
    dot_matrix: dotMatrixImpl,
    dithering: ditheringImpl,
    palette_map: paletteMapImpl,
    color_depth: colorDepthImpl,
    anaglyph_3d: anaglyph3d,
    chromatic_aberration: chromaticAberration,
    rgb_split: rgbSplit,
    color_splash: colorSplash,
    heat_map: heatMap,
    night_vision: nightVision,
    thermal_vision: thermalVision,
    infrared_false_color: infraredFalseColor,
    remove_background: removeBackground,
    add_noise: addNoise,
    tv_static: tvStatic,
    scanline: scanlineImpl,
    vignette: vignetteImpl,
    slice: sliceImpl,
    smooth: smoothImpl,
    retro_sunset: retroSunset,
    tilt_shift: tiltShift,
};

/** F1 has no frame effects (the batch keeps the canvas size). */
export const FILTER_F1_FRAME_IDS: string[] = [];
