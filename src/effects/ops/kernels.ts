/**
 * Convolution, blur and edge operators. Every function is pure (new buffer)
 * and radii are clamped so previews stay bounded.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    luminance,
    makeImageData,
    parseColor,
} from "../pixels.ts";
import type { Insets } from "../types.ts";
import { sampleBilinear } from "./warp.ts";

export interface PaddedResult {
    data: ImageData;
    pad: Insets;
}

/** Generic convolution with a normalising divisor, offset and edge clamping. */
export function convolve(
    src: ImageData,
    kernel: number[],
    kW: number,
    kH: number,
    divisor = 1,
    offset = 0
): ImageData {
    const w = src.width;
    const h = src.height;
    const kLength = kW * kH;
    if (kW < 1 || kH < 1 || kernel.length !== kLength) {
        return cloneImageData(src);
    }
    const out = makeImageData(w, h);
    const s = src.data;
    const d = out.data;
    const cx = (kW - 1) >> 1;
    const cy = (kH - 1) >> 1;
    const div = divisor === 0 ? 1 : divisor;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let ki = 0;
            for (let ky = 0; ky < kH; ky++) {
                let sy = y + ky - cy;
                if (sy < 0) {
                    sy = 0;
                } else if (sy >= h) {
                    sy = h - 1;
                }
                for (let kx = 0; kx < kW; kx++) {
                    let sx = x + kx - cx;
                    if (sx < 0) {
                        sx = 0;
                    } else if (sx >= w) {
                        sx = w - 1;
                    }
                    const weight = kernel[ki++];
                    const i = (sy * w + sx) * 4;
                    r += s[i] * weight;
                    g += s[i + 1] * weight;
                    b += s[i + 2] * weight;
                    a += s[i + 3] * weight;
                }
            }
            const o = (y * w + x) * 4;
            d[o] = clamp255(r / div + offset);
            d[o + 1] = clamp255(g / div + offset);
            d[o + 2] = clamp255(b / div + offset);
            d[o + 3] = clamp255(a / div + offset);
        }
    }
    return out;
}

function boxBlurH(src: Uint8ClampedArray, dst: Float32Array, w: number, h: number, r: number): void {
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        for (let k = -r; k <= r; k++) {
            const xi = k < 0 ? 0 : k >= w ? w - 1 : k;
            const i = row + xi * 4;
            sr += src[i];
            sg += src[i + 1];
            sb += src[i + 2];
            sa += src[i + 3];
        }
        for (let x = 0; x < w; x++) {
            const o = row + x * 4;
            dst[o] = sr / win;
            dst[o + 1] = sg / win;
            dst[o + 2] = sb / win;
            dst[o + 3] = sa / win;
            const rem = x - r < 0 ? 0 : x - r;
            let add = x + r + 1;
            if (add >= w) {
                add = w - 1;
            }
            const ri = row + rem * 4;
            const ai = row + add * 4;
            sr += src[ai] - src[ri];
            sg += src[ai + 1] - src[ri + 1];
            sb += src[ai + 2] - src[ri + 2];
            sa += src[ai + 3] - src[ri + 3];
        }
    }
}

function boxBlurV(src: Float32Array, dst: Uint8ClampedArray, w: number, h: number, r: number): void {
    const win = 2 * r + 1;
    for (let x = 0; x < w; x++) {
        const col = x * 4;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        for (let k = -r; k <= r; k++) {
            const yi = k < 0 ? 0 : k >= h ? h - 1 : k;
            const i = (yi * w + x) * 4;
            sr += src[i];
            sg += src[i + 1];
            sb += src[i + 2];
            sa += src[i + 3];
        }
        for (let y = 0; y < h; y++) {
            const o = (y * w + x) * 4;
            dst[o] = sr / win;
            dst[o + 1] = sg / win;
            dst[o + 2] = sb / win;
            dst[o + 3] = sa / win;
            const rem = y - r < 0 ? 0 : y - r;
            let add = y + r + 1;
            if (add >= h) {
                add = h - 1;
            }
            const ri = (rem * w + x) * 4;
            const ai = (add * w + x) * 4;
            sr += src[ai] - src[ri];
            sg += src[ai + 1] - src[ri + 1];
            sb += src[ai + 2] - src[ri + 2];
            sa += src[ai + 3] - src[ri + 3];
        }
    }
}

/** Separable box blur. */
export function boxBlur(src: ImageData, radius: number): ImageData {
    const r = Math.round(clamp(radius, 0, 200));
    if (r < 1) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const temp = new Float32Array(w * h * 4);
    boxBlurH(src.data, temp, w, h, r);
    const out = makeImageData(w, h);
    boxBlurV(temp, out.data, w, h, r);
    return out;
}

/** Separable gaussian blur (3-sigma support). */
export function gaussianBlur(src: ImageData, radius: number): ImageData {
    const r = clamp(radius, 0, 150);
    if (r < 0.5) {
        return cloneImageData(src);
    }
    const kr = Math.max(1, Math.ceil(r));
    const sigma = r / 2;
    const size = kr * 2 + 1;
    const kernel = new Float32Array(size);
    let sum = 0;
    for (let i = 0; i < size; i++) {
        const d = i - kr;
        const v = Math.exp(-(d * d) / (2 * sigma * sigma));
        kernel[i] = v;
        sum += v;
    }
    for (let i = 0; i < size; i++) {
        kernel[i] /= sum;
    }
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const temp = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
            let rr = 0;
            let gg = 0;
            let bb = 0;
            let aa = 0;
            for (let k = 0; k < size; k++) {
                let sx = x + k - kr;
                if (sx < 0) {
                    sx = 0;
                } else if (sx >= w) {
                    sx = w - 1;
                }
                const i = row + sx * 4;
                const kw = kernel[k];
                rr += s[i] * kw;
                gg += s[i + 1] * kw;
                bb += s[i + 2] * kw;
                aa += s[i + 3] * kw;
            }
            const o = row + x * 4;
            temp[o] = rr;
            temp[o + 1] = gg;
            temp[o + 2] = bb;
            temp[o + 3] = aa;
        }
    }
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let rr = 0;
            let gg = 0;
            let bb = 0;
            let aa = 0;
            for (let k = 0; k < size; k++) {
                let sy = y + k - kr;
                if (sy < 0) {
                    sy = 0;
                } else if (sy >= h) {
                    sy = h - 1;
                }
                const i = (sy * w + x) * 4;
                const kw = kernel[k];
                rr += temp[i] * kw;
                gg += temp[i + 1] * kw;
                bb += temp[i + 2] * kw;
                aa += temp[i + 3] * kw;
            }
            const o = (y * w + x) * 4;
            d[o] = clamp255(rr);
            d[o + 1] = clamp255(gg);
            d[o + 2] = clamp255(bb);
            d[o + 3] = clamp255(aa);
        }
    }
    return out;
}

/** Median rank filter (radius clamped to 1..3) via per-row sliding histograms. */
export function medianFilter(src: ImageData, radius: number): ImageData {
    const r = Math.round(clamp(radius, 1, 3));
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const win = (2 * r + 1) * (2 * r + 1);
    const target = (win - 1) >> 1;
    const hist0 = new Uint32Array(256);
    const hist1 = new Uint32Array(256);
    const hist2 = new Uint32Array(256);
    const hist3 = new Uint32Array(256);
    const hists = [hist0, hist1, hist2, hist3];
    const med = new Int32Array(4);
    const below = new Int32Array(4);
    const rows = new Int32Array(2 * r + 1);
    const cols = new Int32Array(2 * r + 1);
    med[3] = 255;
    let opaque = true;
    for (let i = 3; i < s.length; i += 4) {
        if (s[i] !== 255) {
            opaque = false;
            break;
        }
    }
    const ch = opaque ? 3 : 4;
    for (let y = 0; y < h; y++) {
        for (let c = 0; c < ch; c++) {
            hists[c].fill(0);
        }
        for (let k = 0; k <= 2 * r; k++) {
            const sy = y + k - r;
            rows[k] = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
            const sx = k - r;
            cols[k] = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
        }
        for (let k = 0; k <= 2 * r; k++) {
            const row = rows[k] * w;
            for (let j = 0; j <= 2 * r; j++) {
                const i = (row + cols[j]) * 4;
                hist0[s[i]]++;
                hist1[s[i + 1]]++;
                hist2[s[i + 2]]++;
                if (ch === 4) {
                    hist3[s[i + 3]]++;
                }
            }
        }
        for (let c = 0; c < ch; c++) {
            const hist = hists[c];
            let m = 0;
            let cum = hist[0];
            while (cum <= target && m < 255) {
                m++;
                cum += hist[m];
            }
            med[c] = m;
            below[c] = cum - hist[m];
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            d[o] = med[0];
            d[o + 1] = med[1];
            d[o + 2] = med[2];
            d[o + 3] = ch === 3 ? 255 : med[3];
            if (x === w - 1) {
                break;
            }
            for (let j = 0; j <= 2 * r; j++) {
                const nx = x + 1 - r + j;
                const nc = nx < 0 ? 0 : nx >= w ? w - 1 : nx;
                const oc = cols[j];
                if (nc === oc) {
                    continue;
                }
                for (let k = 0; k <= 2 * r; k++) {
                    const row = rows[k] * w;
                    const oi = (row + oc) * 4;
                    const v0 = s[oi];
                    const v1 = s[oi + 1];
                    const v2 = s[oi + 2];
                    hist0[v0]--;
                    hist1[v1]--;
                    hist2[v2]--;
                    if (v0 < med[0]) {
                        below[0]--;
                    }
                    if (v1 < med[1]) {
                        below[1]--;
                    }
                    if (v2 < med[2]) {
                        below[2]--;
                    }
                    if (ch === 4) {
                        const v3 = s[oi + 3];
                        hist3[v3]--;
                        if (v3 < med[3]) {
                            below[3]--;
                        }
                    }
                    const ni = (row + nc) * 4;
                    const w0 = s[ni];
                    const w1 = s[ni + 1];
                    const w2 = s[ni + 2];
                    hist0[w0]++;
                    hist1[w1]++;
                    hist2[w2]++;
                    if (w0 < med[0]) {
                        below[0]++;
                    }
                    if (w1 < med[1]) {
                        below[1]++;
                    }
                    if (w2 < med[2]) {
                        below[2]++;
                    }
                    if (ch === 4) {
                        const w3 = s[ni + 3];
                        hist3[w3]++;
                        if (w3 < med[3]) {
                            below[3]++;
                        }
                    }
                }
                cols[j] = nc;
            }
            for (let c = 0; c < ch; c++) {
                const hist = hists[c];
                let m = med[c];
                let b = below[c];
                while (b > target && m > 0) {
                    m--;
                    b -= hist[m];
                }
                while (b + hist[m] <= target && m < 255) {
                    b += hist[m];
                    m++;
                }
                med[c] = m;
                below[c] = b;
            }
        }
    }
    return out;
}

/** High-pass "mean removal" convolution. */
export function meanRemoval(src: ImageData): ImageData {
    return convolve(src, [-1, -1, -1, -1, 9, -1, -1, -1, -1], 3, 3, 1, 0);
}

/** Surface blur: averages neighbours within a luminance threshold. */
export function surfaceBlur(src: ImageData, radius: number, thresholdValue: number): ImageData {
    const r = Math.round(clamp(radius, 1, 8));
    const th = clamp(thresholdValue, 0, 255);
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = luminance(s[i], s[i + 1], s[i + 2]);
            let r0 = 0;
            let g0 = 0;
            let b0 = 0;
            let a0 = 0;
            let count = 0;
            for (let ky = -r; ky <= r; ky++) {
                let sy = y + ky;
                if (sy < 0) {
                    sy = 0;
                } else if (sy >= h) {
                    sy = h - 1;
                }
                for (let kx = -r; kx <= r; kx++) {
                    let sx = x + kx;
                    if (sx < 0) {
                        sx = 0;
                    } else if (sx >= w) {
                        sx = w - 1;
                    }
                    const si = (sy * w + sx) * 4;
                    const dl = Math.abs(luminance(s[si], s[si + 1], s[si + 2]) - lum);
                    if (dl <= th) {
                        r0 += s[si];
                        g0 += s[si + 1];
                        b0 += s[si + 2];
                        a0 += s[si + 3];
                        count++;
                    }
                }
            }
            if (count === 0) {
                count = 1;
            }
            d[i] = r0 / count;
            d[i + 1] = g0 / count;
            d[i + 2] = b0 / count;
            d[i + 3] = a0 / count;
        }
    }
    return out;
}

/** Directional motion blur (distance in px, angle in degrees). */
export function motionBlur(src: ImageData, distance: number, angle: number): ImageData {
    const dist = clamp(distance, 0, 200);
    if (dist < 0.5) {
        return cloneImageData(src);
    }
    const samples = Math.max(2, Math.min(64, Math.round(dist) + 1));
    const rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = 0; k < samples; k++) {
                const t = (k / (samples - 1) - 0.5) * dist;
                if (sampleBilinear(src, x + dx * t, y + dy * t, px)) {
                    r += px[0];
                    g += px[1];
                    b += px[2];
                    a += px[3];
                }
            }
            const o = (y * w + x) * 4;
            d[o] = r / samples;
            d[o + 1] = g / samples;
            d[o + 2] = b / samples;
            d[o + 3] = a / samples;
        }
    }
    return out;
}

/** Rotational blur around a normalised centre (0..1). */
export function spinBlur(
    src: ImageData,
    angle: number,
    samples: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const total = (clamp(angle, -360, 360) * Math.PI) / 180;
    if (Math.abs(total) < 0.001) {
        return cloneImageData(src);
    }
    const count = Math.max(2, Math.min(64, Math.round(samples)));
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = 0; k < count; k++) {
                const t = total * (k / (count - 1) - 0.5);
                const cos = Math.cos(t);
                const sin = Math.sin(t);
                const dx = x - cx;
                const dy = y - cy;
                if (sampleBilinear(src, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, px)) {
                    r += px[0];
                    g += px[1];
                    b += px[2];
                    a += px[3];
                }
            }
            const o = (y * w + x) * 4;
            d[o] = r / count;
            d[o + 1] = g / count;
            d[o + 2] = b / count;
            d[o + 3] = a / count;
        }
    }
    return out;
}

/** Radial zoom blur towards a normalised centre. */
export function zoomBlur(
    src: ImageData,
    strength: number,
    samples: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const amount = clamp(strength, 0, 100) / 100;
    if (amount < 0.001) {
        return cloneImageData(src);
    }
    const count = Math.max(2, Math.min(64, Math.round(samples)));
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = 0; k < count; k++) {
                const s = 1 + amount * (k / (count - 1) - 0.5) * 2;
                if (sampleBilinear(src, cx + (x - cx) * s, cy + (y - cy) * s, px)) {
                    r += px[0];
                    g += px[1];
                    b += px[2];
                    a += px[3];
                }
            }
            const o = (y * w + x) * 4;
            d[o] = r / count;
            d[o + 1] = g / count;
            d[o + 2] = b / count;
            d[o + 3] = a / count;
        }
    }
    return out;
}

/** Circular lens blur with highlight weighting. */
export function lensBlur(
    src: ImageData,
    radius: number,
    highlightThreshold: number,
    highlightBoost: number
): ImageData {
    const r = clamp(radius, 0, 50);
    if (r < 0.5) {
        return cloneImageData(src);
    }
    const count = Math.max(8, Math.min(64, Math.round(r * 2.5)));
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    const th = clamp(highlightThreshold, 0, 255);
    const boost = 1 + (clamp(highlightBoost, 0, 100) / 100) * 4;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r0 = 0;
            let g0 = 0;
            let b0 = 0;
            let a0 = 0;
            let weight = 0;
            for (let k = 0; k < count; k++) {
                const rad = r * Math.sqrt((k + 0.5) / count);
                const ang = k * golden;
                if (sampleBilinear(src, x + Math.cos(ang) * rad, y + Math.sin(ang) * rad, px)) {
                    const lum = luminance(px[0], px[1], px[2]);
                    const wgt = lum >= th ? boost : 1;
                    r0 += px[0] * wgt;
                    g0 += px[1] * wgt;
                    b0 += px[2] * wgt;
                    a0 += px[3] * wgt;
                    weight += wgt;
                }
            }
            const o = (y * w + x) * 4;
            if (weight > 0) {
                d[o] = r0 / weight;
                d[o + 1] = g0 / weight;
                d[o + 2] = b0 / weight;
                d[o + 3] = a0 / weight;
            }
        }
    }
    return out;
}

/** 3x3 sharpen where strength 50 ≈ classic amount. */
export function sharpen(src: ImageData, strength: number): ImageData {
    const a = clamp(strength, 0, 500) / 100;
    return convolve(
        src,
        [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0],
        3,
        3,
        1,
        0
    );
}

/** Unsharp mask with amount/radius/threshold. */
export function unsharpMask(
    src: ImageData,
    radius: number,
    amount: number,
    thresholdValue: number
): ImageData {
    const blurred = gaussianBlur(src, radius);
    const amt = clamp(amount, 0, 500) / 100;
    const th = clamp(thresholdValue, 0, 255);
    const out = makeImageData(src.width, src.height);
    const s = src.data;
    const b = blurred.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const diff = s[i + c] - b[i + c];
            d[i + c] = Math.abs(diff) >= th ? clamp255(s[i + c] + diff * amt) : s[i + c];
        }
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Laplacian edge detect, rendered as grey. */
export function edgeDetect(src: ImageData): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const xm = x > 0 ? x - 1 : 0;
            const xp = x + 1 < w ? x + 1 : w - 1;
            const ym = y > 0 ? y - 1 : 0;
            const yp = y + 1 < h ? y + 1 : h - 1;
            const c = luminance(s[(y * w + x) * 4], s[(y * w + x) * 4 + 1], s[(y * w + x) * 4 + 2]);
            const l = luminance(s[(y * w + xm) * 4], s[(y * w + xm) * 4 + 1], s[(y * w + xm) * 4 + 2]);
            const r = luminance(s[(y * w + xp) * 4], s[(y * w + xp) * 4 + 1], s[(y * w + xp) * 4 + 2]);
            const t = luminance(s[(ym * w + x) * 4], s[(ym * w + x) * 4 + 1], s[(ym * w + x) * 4 + 2]);
            const bt = luminance(s[(yp * w + x) * 4], s[(yp * w + x) * 4 + 1], s[(yp * w + x) * 4 + 2]);
            const v = clamp255(Math.abs(4 * c - l - r - t - bt));
            const i = (y * w + x) * 4;
            d[i] = v;
            d[i + 1] = v;
            d[i + 2] = v;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

function lumAt(data: Uint8ClampedArray, w: number, x: number, y: number): number {
    const i = (y * w + x) * 4;
    return luminance(data[i], data[i + 1], data[i + 2]);
}

/** Sobel magnitude edge with strength and threshold. */
export function sobelEdge(src: ImageData, strength: number, thresholdValue: number): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const k = clamp(strength, 0, 10);
    const cut = clamp(thresholdValue, 0, 255);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const xm = x > 0 ? x - 1 : 0;
            const xp = x + 1 < w ? x + 1 : w - 1;
            const ym = y > 0 ? y - 1 : 0;
            const yp = y + 1 < h ? y + 1 : h - 1;
            const tl = lumAt(s, w, xm, ym);
            const tc = lumAt(s, w, x, ym);
            const tr = lumAt(s, w, xp, ym);
            const ml = lumAt(s, w, xm, y);
            const mr = lumAt(s, w, xp, y);
            const bl = lumAt(s, w, xm, yp);
            const bc = lumAt(s, w, x, yp);
            const br = lumAt(s, w, xp, yp);
            const gx = tl + 2 * ml + bl - tr - 2 * mr - br;
            const gy = tl + 2 * tc + tr - bl - 2 * bc - br;
            let v = Math.sqrt(gx * gx + gy * gy) * k;
            if (v < cut) {
                v = 0;
            }
            v = clamp255(v);
            const i = (y * w + x) * 4;
            d[i] = v;
            d[i + 1] = v;
            d[i + 2] = v;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Grayscale emboss with a light NW→SE direction. */
export function emboss(src: ImageData): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const xm = x > 0 ? x - 1 : 0;
            const xp = x + 1 < w ? x + 1 : w - 1;
            const ym = y > 0 ? y - 1 : 0;
            const yp = y + 1 < h ? y + 1 : h - 1;
            const v = clamp255(
                lumAt(s, w, xm, ym) * -2 + lumAt(s, w, x, ym) * -1 +
                lumAt(s, w, xm, y) * -1 + lumAt(s, w, x, y) * 1 + lumAt(s, w, xp, y) * 1 +
                lumAt(s, w, x, yp) * 1 + lumAt(s, w, xp, yp) * 2 + 128
            );
            const i = (y * w + x) * 4;
            d[i] = v;
            d[i + 1] = v;
            d[i + 2] = v;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

function blurFloat(src: Float32Array, w: number, h: number, r: number): Float32Array {
    if (r < 1) {
        return src.slice();
    }
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let k = -r; k <= r; k++) {
            sum += src[row + (k < 0 ? 0 : k >= w ? w - 1 : k)];
        }
        for (let x = 0; x < w; x++) {
            tmp[row + x] = sum / win;
            const rem = x - r < 0 ? 0 : x - r;
            const add = x + r + 1 >= w ? w - 1 : x + r + 1;
            sum += src[row + add] - src[row + rem];
        }
    }
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
            sum += tmp[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
        }
        for (let y = 0; y < h; y++) {
            out[y * w + x] = sum / win;
            const rem = y - r < 0 ? 0 : y - r;
            const add = y + r + 1 >= h ? h - 1 : y + r + 1;
            sum += tmp[add * w + x] - tmp[rem * w + x];
        }
    }
    return out;
}

/** Directional bevel shading derived from blurred luminance. */
export function bevel(
    src: ImageData,
    size: number,
    strength: number,
    lightAngle: number,
    highlightColor: string,
    shadowColor: string
): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const r = Math.round(clamp(size, 1, 32));
    const amt = clamp(strength, 0, 200) / 100;
    const rad = (lightAngle * Math.PI) / 180;
    const ox = Math.round(Math.cos(rad) * r);
    const oy = Math.round(Math.sin(rad) * r);
    const [hr, hg, hb, ha] = parseColor(highlightColor);
    const [sr, sg, sb, sa] = parseColor(shadowColor);
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < s.length; i += 4, p++) {
        lum[p] = luminance(s[i], s[i + 1], s[i + 2]);
    }
    const blurred = blurFloat(lum, w, h, r);
    const out = makeImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let hx = x + ox;
            let hy = y + oy;
            let sx2 = x - ox;
            let sy2 = y - oy;
            hx = hx < 0 ? 0 : hx >= w ? w - 1 : hx;
            hy = hy < 0 ? 0 : hy >= h ? h - 1 : hy;
            sx2 = sx2 < 0 ? 0 : sx2 >= w ? w - 1 : sx2;
            sy2 = sy2 < 0 ? 0 : sy2 >= h ? h - 1 : sy2;
            const diff = (blurred[hy * w + hx] - blurred[sy2 * w + sx2]) / 255;
            const i = (y * w + x) * 4;
            if (diff > 0.002) {
                const k = Math.min(1, diff * amt * 2.4);
                d[i] = s[i] + (hr - s[i]) * k;
                d[i + 1] = s[i + 1] + (hg - s[i + 1]) * k;
                d[i + 2] = s[i + 2] + (hb - s[i + 2]) * k;
                d[i + 3] = s[i + 3] + (ha - s[i + 3]) * k;
            } else if (diff < -0.002) {
                const k = Math.min(1, -diff * amt * 2.4);
                d[i] = s[i] + (sr - s[i]) * k;
                d[i + 1] = s[i + 1] + (sg - s[i + 1]) * k;
                d[i + 2] = s[i + 2] + (sb - s[i + 2]) * k;
                d[i + 3] = s[i + 3] + (sa - s[i + 3]) * k;
            } else {
                d[i] = s[i];
                d[i + 1] = s[i + 1];
                d[i + 2] = s[i + 2];
                d[i + 3] = s[i + 3];
            }
        }
    }
    return out;
}

/** Draws an outline around the alpha silhouette, expanding by padding. */
export function outline(
    src: ImageData,
    size: number,
    padding: number,
    color: string,
    outlineOnly: boolean
): PaddedResult {
    const w = src.width;
    const h = src.height;
    const pad = Math.round(clamp(padding, 0, 64));
    const thickness = Math.round(clamp(size, 1, 32));
    const ow = w + pad * 2;
    const oh = h + pad * 2;
    const s = src.data;
    const mask = new Uint8Array(ow * oh);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (s[(y * w + x) * 4 + 3] > 24) {
                mask[(y + pad) * ow + x + pad] = 1;
            }
        }
    }
    // Separable max dilation: horizontal then vertical.
    const mid = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
            let v = 0;
            for (let k = -thickness; k <= thickness && v === 0; k++) {
                const xx = x + k;
                if (xx >= 0 && xx < ow && mask[y * ow + xx] === 1) {
                    v = 1;
                }
            }
            mid[y * ow + x] = v;
        }
    }
    const dilated = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
            let v = 0;
            for (let k = -thickness; k <= thickness && v === 0; k++) {
                const yy = y + k;
                if (yy >= 0 && yy < oh && mid[yy * ow + x] === 1) {
                    v = 1;
                }
            }
            dilated[y * ow + x] = v;
        }
    }
    const [cr, cg, cb, ca] = parseColor(color);
    const out = makeImageData(ow, oh);
    const d = out.data;
    const eroded = mask;
    for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
            const i = (y * ow + x) * 4;
            const inside = eroded[y * ow + x] === 1;
            const ring = dilated[y * ow + x] === 1 && !inside;
            if (outlineOnly) {
                if (ring) {
                    d[i] = cr;
                    d[i + 1] = cg;
                    d[i + 2] = cb;
                    d[i + 3] = ca;
                }
                continue;
            }
            if (inside) {
                const si = ((y - pad) * w + (x - pad)) * 4;
                d[i] = s[si];
                d[i + 1] = s[si + 1];
                d[i + 2] = s[si + 2];
                d[i + 3] = s[si + 3];
            } else if (ring) {
                d[i] = cr;
                d[i + 1] = cg;
                d[i + 2] = cb;
                d[i + 3] = ca;
            }
        }
    }
    return {
        data: out,
        pad: { top: pad, right: pad, bottom: pad, left: pad },
    };
}

/** Fades alpha towards zero within `radius` px of the canvas border. */
export function edgeFeather(src: ImageData, radius: number): ImageData {
    const r = clamp(radius, 0, 200);
    if (r < 0.5) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const out = cloneImageData(src);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        const dy = Math.min(y, h - 1 - y);
        for (let x = 0; x < w; x++) {
            const dx2 = Math.min(x, w - 1 - x);
            const dist = Math.min(dx2, dy);
            const t = clamp(dist / r, 0, 1);
            const f = t * t * (3 - 2 * t);
            d[(y * w + x) * 4 + 3] *= f;
        }
    }
    return out;
}
