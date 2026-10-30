/**
 * Geometry warps. All functions operate on ImageData and return a new buffer
 * with the same dimensions. Sampling is bilinear; out-of-range samples become
 * transparent (or an explicit background colour).
 */
import { clamp, clamp255, makeImageData, parseColor } from "../pixels.ts";
import { fbm, noiseField } from "./textures.ts";

/** Mutable sample returned by a warp mapper. */
export interface WarpSample {
    sx: number;
    sy: number;
    ok: boolean;
}

/** Maps a destination pixel to source coordinates. */
export type WarpMapper = (x: number, y: number, sample: WarpSample) => void;

/** Bilinear sampler writing RGBA into `out` at `offset`; false when outside. */
export function sampleBilinear(
    src: ImageData,
    x: number,
    y: number,
    out: Float32Array,
    offset = 0
): boolean {
    const w = src.width;
    const h = src.height;
    const d = src.data;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) {
        out[offset] = 0;
        out[offset + 1] = 0;
        out[offset + 2] = 0;
        out[offset + 3] = 0;
        return false;
    }
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
    const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
    const ax = x0 < 0 ? 0 : x0;
    const ay = y0 < 0 ? 0 : y0;
    const i00 = (ay * w + ax) * 4;
    const i10 = (ay * w + x1) * 4;
    const i01 = (y1 * w + ax) * 4;
    const i11 = (y1 * w + x1) * 4;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    out[offset] = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
    out[offset + 1] = d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
    out[offset + 2] = d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
    out[offset + 3] = d[i00 + 3] * w00 + d[i10 + 3] * w10 + d[i01 + 3] * w01 + d[i11 + 3] * w11;
    return true;
}

/** Runs a generic coordinate warp over every destination pixel. */
export function warp(
    src: ImageData,
    mapper: WarpMapper,
    background: [number, number, number, number] = [0, 0, 0, 0]
): ImageData {
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const sample: WarpSample = { sx: 0, sy: 0, ok: false };
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            mapper(x, y, sample);
            const i = (y * w + x) * 4;
            if (sample.ok && sampleBilinear(src, sample.sx, sample.sy, px)) {
                d[i] = px[0];
                d[i + 1] = px[1];
                d[i + 2] = px[2];
                d[i + 3] = px[3];
            } else {
                d[i] = background[0];
                d[i + 1] = background[1];
                d[i + 2] = background[2];
                d[i + 3] = background[3];
            }
        }
    }
    return out;
}

/** Solves a small dense linear system with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] | null {
    const n = b.length;
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
                pivot = row;
            }
        }
        if (Math.abs(a[pivot][col]) < 1e-12) {
            return null;
        }
        if (pivot !== col) {
            const tmpRow = a[pivot];
            a[pivot] = a[col];
            a[col] = tmpRow;
            const tmp = b[pivot];
            b[pivot] = b[col];
            b[col] = tmp;
        }
        const div = a[col][col];
        for (let c = col; c < n; c++) {
            a[col][c] /= div;
        }
        b[col] /= div;
        for (let row = 0; row < n; row++) {
            if (row === col) {
                continue;
            }
            const factor = a[row][col];
            if (factor === 0) {
                continue;
            }
            for (let c = col; c < n; c++) {
                a[row][c] -= factor * a[col][c];
            }
            b[row] -= factor * b[col];
        }
    }
    return b;
}

/** Homography mapping the unit square to a destination quad (8 unknowns). */
function homographyFromQuad(quad: number[][]): number[] | null {
    const a: number[][] = [];
    const b: number[] = [];
    const base = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
    ];
    for (let k = 0; k < 4; k++) {
        const u = base[k][0];
        const v = base[k][1];
        const x = quad[k][0];
        const y = quad[k][1];
        a.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
        b.push(x);
        a.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
        b.push(y);
    }
    const solved = solveLinear(a, b);
    return solved ? [...solved, 1] : null;
}

/** Inverts a 3x3 homogeneous matrix. */
function invert3x3(m: number[]): number[] | null {
    const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-12) {
        return null;
    }
    const inv = 1 / det;
    return [
        (m[4] * m[8] - m[5] * m[7]) * inv,
        (m[2] * m[7] - m[1] * m[8]) * inv,
        (m[1] * m[5] - m[2] * m[4]) * inv,
        (m[5] * m[6] - m[3] * m[8]) * inv,
        (m[0] * m[8] - m[2] * m[6]) * inv,
        (m[2] * m[3] - m[0] * m[5]) * inv,
        (m[3] * m[7] - m[4] * m[6]) * inv,
        (m[1] * m[6] - m[0] * m[7]) * inv,
        (m[0] * m[4] - m[1] * m[3]) * inv,
    ];
}

function multiply3x3(a: number[], b: number[]): number[] {
    const out = new Array<number>(9).fill(0);
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
            let sum = 0;
            for (let k = 0; k < 3; k++) {
                sum += a[row * 3 + k] * b[k * 3 + col];
            }
            out[row * 3 + col] = sum;
        }
    }
    return out;
}

/** Applies an inverse homography to every pixel with bilinear sampling. */
function warpHomography(src: ImageData, inv: number[]): ImageData {
    const w = src.width;
    const h = src.height;
    return warp(src, (x, y, sample) => {
        const dx = x + 0.5;
        const dy = y + 0.5;
        const den = inv[6] * dx + inv[7] * dy + inv[8];
        if (Math.abs(den) < 1e-9) {
            sample.ok = false;
            return;
        }
        const u = (inv[0] * dx + inv[1] * dy + inv[2]) / den;
        const v = (inv[3] * dx + inv[4] * dy + inv[5]) / den;
        sample.sx = u * w - 0.5;
        sample.sy = v * h - 0.5;
        sample.ok = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    });
}

export interface PerspectiveOffsets {
    topLeftX: number;
    topLeftY: number;
    topRightX: number;
    topRightY: number;
    bottomRightX: number;
    bottomRightY: number;
    bottomLeftX: number;
    bottomLeftY: number;
}

/** Perspective warp defined by per-corner pixel offsets. */
export function perspectiveWarp(src: ImageData, o: PerspectiveOffsets): ImageData {
    const w = src.width;
    const h = src.height;
    const quad = [
        [o.topLeftX, o.topLeftY],
        [w + o.topRightX, o.topRightY],
        [w + o.bottomRightX, h + o.bottomRightY],
        [o.bottomLeftX, h + o.bottomLeftY],
    ];
    const fwd = homographyFromQuad(quad);
    if (!fwd) {
        return warpHomography(src, [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1]);
    }
    const inv = invert3x3(fwd);
    if (!inv) {
        return warpHomography(src, [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1]);
    }
    return warpHomography(src, inv);
}

/** Horizontal / vertical skew in degrees. */
export function skew(src: ImageData, horizontally: number, vertically: number): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = w / 2;
    const cy = h / 2;
    const th = Math.tan((clamp(horizontally, -60, 60) * Math.PI) / 180);
    const tv = Math.tan((clamp(vertically, -60, 60) * Math.PI) / 180);
    return warp(src, (x, y, sample) => {
        const nx = x - cx;
        const ny = y - cy;
        sample.sx = cx + nx - th * ny;
        sample.sy = cy + ny - tv * nx;
        sample.ok = true;
    });
}

/** Swirls pixels around a centre; angle in degrees, radius in percent. */
export function twirl(
    src: ImageData,
    angle: number,
    radiusPercent: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const radius = Math.max(1, (clamp(radiusPercent, 1, 300) / 100) * Math.min(w, h));
    const maxAngle = (clamp(angle, -720, 720) * Math.PI) / 180;
    return warp(src, (x, y, sample) => {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const base = Math.atan2(dy, dx);
        let theta = base;
        if (r < radius) {
            const t = 1 - r / radius;
            theta = base + maxAngle * t * t;
        }
        sample.sx = cx + Math.cos(theta) * r;
        sample.sy = cy + Math.sin(theta) * r;
        sample.ok = true;
    });
}

/** Pinch (negative) or bulge (positive) inside a circular radius. */
export function pinchBulge(
    src: ImageData,
    strength: number,
    radiusPercent: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const radius = Math.max(1, (clamp(radiusPercent, 1, 300) / 100) * Math.min(w, h) * 0.75);
    const amount = clamp(strength, -100, 100) / 100;
    return warp(src, (x, y, sample) => {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < radius && r > 0.0001) {
            const f = r / radius;
            const srcR = radius * Math.pow(f, 1 + amount);
            sample.sx = cx + (dx / r) * srcR;
            sample.sy = cy + (dy / r) * srcR;
        } else {
            sample.sx = x;
            sample.sy = y;
        }
        sample.ok = true;
    });
}

/** Fisheye / barrel distortion inside a circular radius. */
export function fisheye(
    src: ImageData,
    strength: number,
    radiusPercent: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const radius = Math.max(1, (clamp(radiusPercent, 1, 300) / 100) * Math.min(w, h) * 0.75);
    const k = (clamp(strength, 0, 100) / 100) * 1.5;
    return warp(src, (x, y, sample) => {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < radius && r > 0.0001) {
            const f = r / radius;
            const srcR = radius * f * (1 + k * f * f);
            sample.sx = cx + (dx / r) * srcR;
            sample.sy = cy + (dy / r) * srcR;
        } else {
            sample.sx = x;
            sample.sy = y;
        }
        sample.ok = true;
    });
}

export type PolarMode = "CartesianToPolar" | "PolarToCartesian";

/** Polar coordinate remapping (cartesian → polar or the inverse). */
export function polarWarp(
    src: ImageData,
    mode: PolarMode,
    rotation: number,
    radiusScale: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const maxR = (Math.min(w, h) / 2) * (clamp(radiusScale, 10, 300) / 100);
    const rot = (rotation * Math.PI) / 180;
    return warp(src, (x, y, sample) => {
        if (mode === "CartesianToPolar") {
            const ang = (x / w) * Math.PI * 2 + rot;
            const rad = (y / h) * maxR;
            sample.sx = cx + Math.cos(ang) * rad;
            sample.sy = cy + Math.sin(ang) * rad;
        } else {
            const dx = x - cx;
            const dy = y - cy;
            const ang = Math.atan2(dy, dx) - rot;
            const rad = Math.sqrt(dx * dx + dy * dy);
            let ring = ang / (Math.PI * 2) + 0.5;
            ring -= Math.floor(ring);
            sample.sx = ring * w;
            sample.sy = (rad / maxR) * h;
        }
        sample.ok = true;
    });
}

/** Mirrored wedges around a centre (kaleidoscope). */
export function kaleidoscope(
    src: ImageData,
    segments: number,
    rotation: number,
    zoom: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const n = Math.max(3, Math.round(clamp(segments, 3, 64)));
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const rot = (rotation * Math.PI) / 180;
    const seg = (Math.PI * 2) / n;
    const scale = clamp(zoom, 10, 400) / 100;
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    return warp(src, (x, y, sample) => {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy) * scale;
        const ang = Math.atan2(dy, dx) + rot;
        let a = ang % seg;
        if (a < 0) {
            a += seg;
        }
        if (a > seg / 2) {
            a = seg - a;
        }
        sample.sx = cx + Math.cos(a) * Math.min(r, maxR);
        sample.sy = cy + Math.sin(a) * Math.min(r, maxR);
        sample.ok = true;
    });
}

/** Repeated mirrored copies of the whole image in a grid. */
export function mirrorTiles(
    src: ImageData,
    columns: number,
    rows: number,
    mirrorAlternateColumns = true,
    mirrorAlternateRows = true
): ImageData {
    const cols = Math.max(1, Math.round(clamp(columns, 1, 20)));
    const rws = Math.max(1, Math.round(clamp(rows, 1, 20)));
    const w = src.width;
    const h = src.height;
    return warp(src, (x, y, sample) => {
        const tx = Math.floor((x / w) * cols);
        const ty = Math.floor((y / h) * rws);
        let fx = (x / w) * cols - tx;
        let fy = (y / h) * rws - ty;
        if (mirrorAlternateColumns && tx % 2 === 1) {
            fx = 1 - fx;
        }
        if (mirrorAlternateRows && ty % 2 === 1) {
            fy = 1 - fy;
        }
        sample.sx = fx * w;
        sample.sy = fy * h;
        sample.ok = true;
    });
}

/** Tiles the whole image into a columns × rows grid. */
export function tileRepeat(src: ImageData, columns: number, rows: number): ImageData {
    return mirrorTiles(src, columns, rows, false, false);
}

/** Shuffles source tiles into a new grid using a deterministic seed. */
export function tileShuffle(
    src: ImageData,
    columns: number,
    rows: number,
    gap: number,
    gapColor: string,
    seed = 1
): ImageData {
    const cols = Math.max(1, Math.round(clamp(columns, 1, 20)));
    const rws = Math.max(1, Math.round(clamp(rows, 1, 20)));
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const [gr, gg, gb, ga] = parseColor(gapColor);
    const g = Math.max(0, Math.round(gap));
    const order: number[] = [];
    for (let i = 0; i < cols * rws; i++) {
        order.push(i);
    }
    let state = (Math.floor(seed) || 1) >>> 0;
    for (let i = order.length - 1; i > 0; i--) {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        const j = Math.floor(r * (i + 1));
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
    for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < w; ix++) {
            const i = (iy * w + ix) * 4;
            d[i] = gr;
            d[i + 1] = gg;
            d[i + 2] = gb;
            d[i + 3] = ga;
            const tx = Math.min(cols - 1, Math.floor((ix / w) * cols));
            const ty = Math.min(rws - 1, Math.floor((iy / h) * rws));
            const localX = ix - (tx * w) / cols;
            const localY = iy - (ty * h) / rws;
            if (localX < g || localY < g) {
                continue;
            }
            const srcTile = order[ty * cols + tx];
            const sxT = srcTile % cols;
            const syT = Math.floor(srcTile / cols);
            const sx = Math.min(w - 1, Math.floor((sxT * w) / cols + localX));
            const sy = Math.min(h - 1, Math.floor((syT * h) / rws + localY));
            const si = (sy * w + sx) * 4;
            d[i] = s[si];
            d[i + 1] = s[si + 1];
            d[i + 2] = s[si + 2];
            d[i + 3] = s[si + 3];
        }
    }
    return out;
}

export type SymmetryDirection = "LeftToRight" | "RightToLeft" | "TopToBottom" | "BottomToTop";

/** Mirrors one half of the image onto the other. */
export function symmetry(src: ImageData, direction: SymmetryDirection): ImageData {
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    d.set(src.data);
    const s = src.data;
    if (direction === "LeftToRight" || direction === "RightToLeft") {
        const mirrorLeft = direction === "LeftToRight";
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < Math.floor(w / 2); x++) {
                const srcX = mirrorLeft ? x : w - 1 - x;
                const dstX = mirrorLeft ? w - 1 - x : x;
                const si = (y * w + srcX) * 4;
                const di = (y * w + dstX) * 4;
                d[di] = s[si];
                d[di + 1] = s[si + 1];
                d[di + 2] = s[si + 2];
                d[di + 3] = s[si + 3];
            }
        }
    } else {
        const mirrorTop = direction === "TopToBottom";
        for (let y = 0; y < Math.floor(h / 2); y++) {
            const srcY = mirrorTop ? y : h - 1 - y;
            const dstY = mirrorTop ? h - 1 - y : y;
            for (let x = 0; x < w; x++) {
                const si = (srcY * w + x) * 4;
                const di = (dstY * w + x) * 4;
                d[di] = s[si];
                d[di + 1] = s[si + 1];
                d[di + 2] = s[si + 2];
                d[di + 3] = s[si + 3];
            }
        }
    }
    return out;
}

export type WaveDirection = "Horizontal" | "Vertical" | "Both";

/** Sine wave coordinate displacement. */
export function waveDistortion(
    src: ImageData,
    amplitude: number,
    wavelength: number,
    direction: WaveDirection
): ImageData {
    const amp = clamp(amplitude, -200, 200);
    const len = Math.max(2, wavelength);
    const horizontal = direction !== "Vertical";
    const vertical = direction !== "Horizontal";
    return warp(src, (x, y, sample) => {
        sample.sx = x + (horizontal ? amp * Math.sin((Math.PI * 2 * y) / len) : 0);
        sample.sy = y + (vertical ? amp * Math.sin((Math.PI * 2 * x) / len) : 0);
        sample.ok = true;
    });
}

/** Concentric ripple displacement with a refraction highlight. */
export function rippleRefraction(
    src: ImageData,
    amplitude: number,
    wavelength: number,
    phase: number,
    refraction: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const amp = clamp(amplitude, -100, 100);
    const len = Math.max(2, wavelength);
    const phaseRad = (phase * Math.PI) / 180;
    const lift = clamp(refraction, 0, 100) / 100;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const r = Math.sqrt(dx * dx + dy * dy);
            const wave = Math.sin((Math.PI * 2 * r) / len - phaseRad);
            const offset = amp * wave;
            const ux = r > 0.0001 ? dx / r : 0;
            const uy = r > 0.0001 ? dy / r : 0;
            const i = (y * w + x) * 4;
            if (sampleBilinear(src, x + ux * offset, y + uy * offset, px)) {
                const shine = 1 + lift * 0.35 * Math.cos((Math.PI * 2 * r) / len - phaseRad);
                d[i] = clamp255(px[0] * shine);
                d[i + 1] = clamp255(px[1] * shine);
                d[i + 2] = clamp255(px[2] * shine);
                d[i + 3] = px[3];
            }
        }
    }
    return out;
}

/** Displaces pixels by a normalised displacement field (noise fallback). */
export function displacementMap(
    src: ImageData,
    amountX: number,
    amountY: number,
    field?: Float32Array,
    fieldWidth = 0,
    fieldHeight = 0,
    seed = 1
): ImageData {
    const w = src.width;
    const h = src.height;
    let map = field;
    let mw = fieldWidth;
    let mh = fieldHeight;
    if (!map || mw <= 0 || mh <= 0) {
        mw = 256;
        mh = 256;
        map = noiseField(mw, mh, 64, seed, 4, 0.5);
    }
    const mapData: Float32Array = map;
    const ax = clamp(amountX, -200, 200);
    const ay = clamp(amountY, -200, 200);
    return warp(src, (x, y, sample) => {
        const fx = clamp(Math.floor((x / w) * mw), 0, mw - 1);
        const fy = clamp(Math.floor((y / h) * mh), 0, mh - 1);
        const v = mapData[fy * mw + fx];
        sample.sx = x + (v - 0.5) * 2 * ax;
        sample.sy = y + (v - 0.5) * 2 * ay;
        sample.ok = true;
    });
}

export type CylinderOrientation = "Vertical" | "Horizontal";

/** Cylinder wrap with optional edge shading. */
export function cylinderWrap(
    src: ImageData,
    orientation: CylinderOrientation,
    curvature: number,
    edgeShading: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const c = clamp(curvature, 0, 100) / 100;
    const shade = clamp(edgeShading, 0, 100) / 100;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const vertical = orientation === "Vertical";
            const nx = vertical ? (x / (w - 1)) * 2 - 1 : (y / (h - 1)) * 2 - 1;
            const clamped = clamp(nx * c, -1, 1);
            const theta = Math.asin(clamped);
            const mapped = (theta / Math.PI + 0.5) * 2 - 1;
            const sx = vertical ? ((mapped + 1) / 2) * (w - 1) : x;
            const sy = vertical ? y : ((mapped + 1) / 2) * (h - 1);
            const i = (y * w + x) * 4;
            if (sampleBilinear(src, sx, sy, px)) {
                const edge = Math.abs(nx);
                const dim = 1 - shade * Math.pow(edge, 3);
                d[i] = clamp255(px[0] * dim);
                d[i + 1] = clamp255(px[1] * dim);
                d[i + 2] = clamp255(px[2] * dim);
                d[i + 3] = px[3];
            }
        }
    }
    return out;
}

/** Glass sphere lens centred on the image. */
export function glassSphere(src: ImageData, radiusPercent: number, refraction: number): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.max(2, (clamp(radiusPercent, 1, 200) / 100) * (Math.min(w, h) / 2));
    const eta = clamp(refraction, 1, 3);
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const r = Math.sqrt(dx * dx + dy * dy);
            const i = (y * w + x) * 4;
            if (r <= radius && r > 0.0001) {
                const f = Math.min(1, r / radius);
                const srcR = radius * Math.sin(Math.asin(f) / eta);
                const ux = dx / r;
                const uy = dy / r;
                if (sampleBilinear(src, cx + ux * srcR, cy + uy * srcR, px)) {
                    const nz = Math.sqrt(Math.max(0, 1 - f * f));
                    const lift = 1 + nz * nz * 0.18;
                    d[i] = clamp255(px[0] * lift);
                    d[i + 1] = clamp255(px[1] * lift);
                    d[i + 2] = clamp255(px[2] * lift);
                    d[i + 3] = px[3];
                }
            } else {
                d[i] = src.data[i];
                d[i + 1] = src.data[i + 1];
                d[i + 2] = src.data[i + 2];
                d[i + 3] = src.data[i + 3];
            }
        }
    }
    return out;
}

/** Pleated crease folding with simple directional shading. */
export function foldCreaseWarp(
    src: ImageData,
    orientation: CylinderOrientation,
    foldCount: number,
    foldDepth: number,
    shadowStrength: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const count = Math.max(1, Math.round(clamp(foldCount, 1, 32)));
    const depth = clamp(foldDepth, 0, 200);
    const shade = clamp(shadowStrength, 0, 100) / 100;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const vertical = orientation === "Vertical";
            const axis = vertical ? x : y;
            const span = vertical ? w : h;
            const period = span / count;
            let t = (axis % period) / period;
            if (t < 0) {
                t += 1;
            }
            const tri = t < 0.5 ? t * 2 : 2 - t * 2;
            const offset = (tri - 0.5) * 2 * depth;
            const sx = vertical ? x + offset : x;
            const sy = vertical ? y : y + offset;
            const i = (y * w + x) * 4;
            if (sampleBilinear(src, sx, sy, px)) {
                const foldShade = 1 + (t < 0.5 ? 1 : -1) * shade * 0.35;
                d[i] = clamp255(px[0] * foldShade);
                d[i + 1] = clamp255(px[1] * foldShade);
                d[i + 2] = clamp255(px[2] * foldShade);
                d[i + 3] = px[3];
            }
        }
    }
    return out;
}

/** Single-step liquify push with an optional smudge blend. */
export function liquifyPush(
    src: ImageData,
    angle: number,
    distance: number,
    radiusPercent: number,
    smudge: number,
    centerXPercent: number,
    centerYPercent: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const cx = (clamp(centerXPercent, -50, 150) / 100) * w;
    const cy = (clamp(centerYPercent, -50, 150) / 100) * h;
    const radius = Math.max(1, (clamp(radiusPercent, 1, 100) / 100) * Math.min(w, h));
    const dist = clamp(distance, -300, 300);
    const rad = (angle * Math.PI) / 180;
    const pushX = Math.cos(rad) * dist;
    const pushY = Math.sin(rad) * dist;
    const smear = clamp(smudge, 0, 100) / 100;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    const py = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const r = Math.sqrt(dx * dx + dy * dy);
            const falloff = r < radius ? Math.pow(1 - r / radius, 2) : 0;
            const i = (y * w + x) * 4;
            const sx = x - pushX * falloff;
            const sy = y - pushY * falloff;
            if (sampleBilinear(src, sx, sy, px)) {
                if (falloff > 0 && smear > 0 && sampleBilinear(src, x, y, py)) {
                    d[i] = px[0] + (py[0] - px[0]) * smear * falloff;
                    d[i + 1] = px[1] + (py[1] - px[1]) * smear * falloff;
                    d[i + 2] = px[2] + (py[2] - px[2]) * smear * falloff;
                    d[i + 3] = px[3];
                } else {
                    d[i] = px[0];
                    d[i + 1] = px[1];
                    d[i + 2] = px[2];
                    d[i + 3] = px[3];
                }
            }
        }
    }
    return out;
}

export type PageCorner = "TopLeft" | "TopRight" | "BottomRight" | "BottomLeft";

/** Corner page curl: folds the corner back and shades the crease. */
export function pageCurl(
    src: ImageData,
    corner: PageCorner,
    curlPercent: number,
    curlDepth: number,
    shadowStrength: number,
    backColor: string
): ImageData {
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const px = new Float32Array(4);
    const [br, bg, bb] = parseColor(backColor);
    const depthMix = clamp(curlDepth, 0, 100) / 100;
    const fold = Math.max(2, (clamp(curlPercent, 1, 100) / 100) * Math.min(w, h));
    const shadow = clamp(shadowStrength, 0, 100) / 100;
    const left = corner === "TopLeft" || corner === "BottomLeft";
    const top = corner === "TopLeft" || corner === "TopRight";
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = left ? x : w - 1 - x;
            const dy = top ? y : h - 1 - y;
            const i = (y * w + x) * 4;
            const dsum = dx + dy;
            if (dsum < fold) {
                const mx = fold - dy;
                const my = fold - dx;
                const sx = left ? mx : w - 1 - mx;
                const sy = top ? my : h - 1 - my;
                if (sampleBilinear(src, sx, sy, px)) {
                    const t = 1 - dsum / fold;
                    const shade = 1 - shadow * (0.35 + 0.35 * t);
                    const mix = 0.45 + 0.4 * depthMix;
                    d[i] = clamp255((px[0] * (1 - mix) + br * mix) * shade);
                    d[i + 1] = clamp255((px[1] * (1 - mix) + bg * mix) * shade);
                    d[i + 2] = clamp255((px[2] * (1 - mix) + bb * mix) * shade);
                    d[i + 3] = px[3];
                }
            } else {
                const shadowBand = fold + fold * 0.45;
                let shade = 1;
                if (dsum < shadowBand) {
                    const t = 1 - (dsum - fold) / (shadowBand - fold);
                    shade = 1 - shadow * 0.45 * t * t;
                }
                d[i] = clamp255(src.data[i] * shade);
                d[i + 1] = clamp255(src.data[i + 1] * shade);
                d[i + 2] = clamp255(src.data[i + 2] * shade);
                d[i + 3] = src.data[i + 3];
            }
        }
    }
    return out;
}

function rotationMatrix3d(xDeg: number, yDeg: number, zDeg: number): number[] {
    const ax = (clamp(xDeg, -180, 180) * Math.PI) / 180;
    const ay = (clamp(yDeg, -180, 180) * Math.PI) / 180;
    const az = (clamp(zDeg, -180, 180) * Math.PI) / 180;
    const cx = Math.cos(ax);
    const sx = Math.sin(ax);
    const cy = Math.cos(ay);
    const sy = Math.sin(ay);
    const cz = Math.cos(az);
    const sz = Math.sin(az);
    const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
    const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
    const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
    return multiply3x3(rz, multiply3x3(ry, rx));
}

/** Rotates the image plane in 3D with perspective (same output size). */
export function rotate3d(
    src: ImageData,
    rotateX: number,
    rotateY: number,
    rotateZ: number
): ImageData {
    return rotate3dPerspective(src, rotateX, rotateY, rotateZ, 2.2);
}

/** Rotate 3D plus depth; `depth` strengthens perspective like an extruded box. */
export function rotate3dBox(
    src: ImageData,
    depth: number,
    rotateX: number,
    rotateY: number,
    rotateZ: number
): ImageData {
    const focal = 2.2 - (clamp(depth, 0, 100) / 100) * 0.9;
    return rotate3dPerspective(src, rotateX, rotateY, rotateZ, Math.max(0.6, focal));
}

function rotate3dPerspective(
    src: ImageData,
    rotateX: number,
    rotateY: number,
    rotateZ: number,
    focal: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const r = rotationMatrix3d(rotateX, rotateY, rotateZ);
    const normScale = [2 / w, 0, -1, 0, 2 / h, -1, 0, 0, 1];
    const proj = [r[0], r[1], 0, r[3], r[4], 0, r[6] / focal, r[7] / focal, 1];
    const back = [w / 2, 0, w / 2, 0, h / 2, h / 2, 0, 0, 1];
    const fwd = multiply3x3(back, multiply3x3(proj, normScale));
    const inv = invert3x3(fwd);
    if (!inv) {
        return warpHomography(src, [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1]);
    }
    return warpHomography(src, inv);
}

/** Heat haze noise refraction; luminance can modulate the displacement. */
export function heatHaze(
    src: ImageData,
    strength: number,
    frequency: number,
    blurRadius: number,
    offset: number,
    luminanceInfluence: number,
    seed = 1
): ImageData {
    const w = src.width;
    const h = src.height;
    const amp = clamp(strength, 0, 200);
    const freq = Math.max(1, frequency) / 100;
    const blur = Math.max(0, Math.min(12, Math.round(blurRadius)));
    const shift = clamp(offset, -100, 100);
    const infl = clamp(luminanceInfluence, 0, 100) / 100;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const px = new Float32Array(4);
    const py = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = (0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2]) / 255;
            const n1 = fbm(x * freq * 0.02 + shift, y * freq * 0.02, 3, 0.5, 2, seed);
            const n2 = fbm(x * freq * 0.02, y * freq * 0.02 + shift, 3, 0.5, 2, seed + 7);
            const scale = 1 + infl * lum;
            const sx = x + (n1 - 0.5) * 2 * amp * scale;
            const sy = y + (n2 - 0.5) * 2 * amp * scale;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let count = 0;
            const step = Math.max(1, blur);
            for (let oy = -blur; oy <= blur; oy += step) {
                for (let ox = -blur; ox <= blur; ox += step) {
                    if (sampleBilinear(src, sx + ox, sy + oy, py)) {
                        r += py[0];
                        g += py[1];
                        b += py[2];
                        a += py[3];
                        count++;
                    }
                }
            }
            if (count > 0) {
                d[i] = r / count;
                d[i + 1] = g / count;
                d[i + 2] = b / count;
                d[i + 3] = a / count;
            }
        }
    }
    return out;
}
