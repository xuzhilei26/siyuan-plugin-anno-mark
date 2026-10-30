/**
 * Stylisation effects: pixelation, mosaics, halftones, dithering, painterly
 * filters and glitch helpers. All functions are pure ImageData transforms.
 */
import {
    clamp,
    clamp255,
    cloneImageData,
    luminance,
    makeImageData,
    parseColor,
} from "../pixels.ts";
import { deriveSeed, mulberry32 } from "../rand.ts";

function sampleNearest(src: ImageData, x: number, y: number, out: Float32Array): void {
    const px = x < 0 ? 0 : x >= src.width ? src.width - 1 : Math.round(x);
    const py = y < 0 ? 0 : y >= src.height ? src.height - 1 : Math.round(y);
    const i = (py * src.width + px) * 4;
    out[0] = src.data[i];
    out[1] = src.data[i + 1];
    out[2] = src.data[i + 2];
    out[3] = src.data[i + 3];
}

function averageBlock(
    src: ImageData,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    out: Float32Array
): void {
    const w = src.width;
    const h = src.height;
    const sx0 = Math.max(0, Math.min(w - 1, Math.floor(x0)));
    const sy0 = Math.max(0, Math.min(h - 1, Math.floor(y0)));
    const sx1 = Math.max(0, Math.min(w - 1, Math.ceil(x1) - 1));
    const sy1 = Math.max(0, Math.min(h - 1, Math.ceil(y1) - 1));
    const d = src.data;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let n = 0;
    for (let y = sy0; y <= sy1; y++) {
        for (let x = sx0; x <= sx1; x++) {
            const i = (y * w + x) * 4;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            a += d[i + 3];
            n++;
        }
    }
    if (n === 0) {
        n = 1;
    }
    out[0] = r / n;
    out[1] = g / n;
    out[2] = b / n;
    out[3] = a / n;
}

/** Square-cell pixelation using block averaging. */
export function pixelate(src: ImageData, size: number): ImageData {
    const cell = Math.max(1, Math.round(clamp(size, 1, 64)));
    if (cell < 2) {
        return cloneImageData(src);
    }
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const avg = new Float32Array(4);
    for (let by = 0; by < h; by += cell) {
        for (let bx = 0; bx < w; bx += cell) {
            averageBlock(src, bx, by, bx + cell, by + cell, avg);
            const y1 = Math.min(h, by + cell);
            const x1 = Math.min(w, bx + cell);
            for (let y = by; y < y1; y++) {
                for (let x = bx; x < x1; x++) {
                    const i = (y * w + x) * 4;
                    d[i] = avg[0];
                    d[i + 1] = avg[1];
                    d[i + 2] = avg[2];
                    d[i + 3] = avg[3];
                }
            }
        }
    }
    return out;
}

export type PixelShape = "square" | "diamond" | "hex" | "triangle";

/** Pixelation with square / diamond / hexagon / triangle cell layouts. */
export function pixelateShape(src: ImageData, size: number, shape: PixelShape): ImageData {
    const cell = Math.max(2, Math.round(clamp(size, 2, 96)));
    if (shape === "square") {
        return pixelate(src, cell);
    }
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const col = new Float32Array(4);
    const hexW = Math.sqrt(3) * cell;
    const hexH = 1.5 * cell;
    const triH = cell * 0.8660254;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let cx = 0;
            let cy = 0;
            if (shape === "diamond") {
                const u = (x + y) / cell;
                const v = (x - y) / cell;
                const cu = Math.floor(u);
                const cv = Math.floor(v);
                cx = ((cu + 0.5) + (cv + 0.5)) * 0.5 * cell;
                cy = ((cu + 0.5) - (cv + 0.5)) * 0.5 * cell;
            } else if (shape === "hex") {
                const row = Math.round(y / hexH);
                const baseCol = Math.round((x - (row % 2 !== 0 ? hexW / 2 : 0)) / hexW);
                let best = Number.POSITIVE_INFINITY;
                for (let ry = row - 1; ry <= row + 1; ry++) {
                    for (let rx = baseCol - 1; rx <= baseCol + 1; rx++) {
                        const px = rx * hexW + (ry % 2 !== 0 ? hexW / 2 : 0);
                        const py = ry * hexH;
                        const dist = (px - x) * (px - x) + (py - y) * (py - y);
                        if (dist < best) {
                            best = dist;
                            cx = px;
                            cy = py;
                        }
                    }
                }
            } else {
                const row = Math.floor(y / triH);
                const offset = (row % 2) * (cell / 2);
                const localX = x - offset;
                const ci = Math.floor(localX / cell);
                const fx = (localX - ci * cell) / cell;
                const fy = (y - row * triH) / triH;
                const up = fx + fy < 1;
                cx = offset + ci * cell + cell * 0.5;
                cy = row * triH + (up ? triH / 3 : (triH * 2) / 3);
            }
            sampleNearest(src, cx, cy, col);
            const i = (y * w + x) * 4;
            d[i] = col[0];
            d[i + 1] = col[1];
            d[i + 2] = col[2];
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

function hashIndex(i: number, j: number, seed: number): number {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

export type MosaicShape = "Hexagon" | "Triangle";

/** Jittered polygon mosaic with optional border lines. */
export function mosaicPolygon(
    src: ImageData,
    cellSize: number,
    shape: MosaicShape,
    borderWidth: number,
    borderOpacity: number,
    randomness: number,
    seed = 1
): ImageData {
    const cell = Math.max(4, Math.round(clamp(cellSize, 4, 96)));
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const jitter = (clamp(randomness, 0, 100) / 100) * cell * 0.45;
    const border = clamp(borderWidth, 0, 8);
    const borderAlpha = clamp(borderOpacity, 0, 100) / 100;
    const rowH = shape === "Hexagon" ? cell * 0.8660254 : cell * 0.8660254;
    const colW = cell;
    const col = new Float32Array(4);
    const [er, eg, eb] = [0, 0, 0];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const baseRow = Math.round(y / rowH);
            const baseCol = Math.round(x / colW);
            let best = Number.POSITIVE_INFINITY;
            let second = Number.POSITIVE_INFINITY;
            let bestX = 0;
            let bestY = 0;
            for (let ry = baseRow - 1; ry <= baseRow + 1; ry++) {
                for (let rx = baseCol - 1; rx <= baseCol + 1; rx++) {
                    const off = ry % 2 !== 0 ? colW / 2 : 0;
                    const cx = rx * colW + off + (hashIndex(rx, ry, seed) - 0.5) * 2 * jitter;
                    const cy = ry * rowH + (hashIndex(rx + 91, ry + 7, seed) - 0.5) * 2 * jitter;
                    const dist = Math.sqrt((cx - x) * (cx - x) + (cy - y) * (cy - y));
                    if (dist < best) {
                        second = best;
                        best = dist;
                        bestX = cx;
                        bestY = cy;
                    } else if (dist < second) {
                        second = dist;
                    }
                }
            }
            sampleNearest(src, bestX, bestY, col);
            const i = (y * w + x) * 4;
            d[i] = col[0];
            d[i + 1] = col[1];
            d[i + 2] = col[2];
            d[i + 3] = col[3];
            if (border > 0 && second - best < border) {
                d[i] = d[i] + (er - d[i]) * borderAlpha;
                d[i + 1] = d[i + 1] + (eg - d[i + 1]) * borderAlpha;
                d[i + 2] = d[i + 2] + (eb - d[i + 2]) * borderAlpha;
            }
        }
    }
    return out;
}

/** Voronoi mosaic built from seeded cell sites. */
export function voronoiMosaic(
    src: ImageData,
    cellCount: number,
    drawEdges: boolean,
    edgeThickness: number,
    edgeColor: string,
    seed = 1
): ImageData {
    const w = src.width;
    const h = src.height;
    const target = Math.max(8, Math.min(3000, Math.round(cellCount)));
    const rand = mulberry32(deriveSeed(seed, "voronoi"));
    const cols = Math.max(1, Math.round(Math.sqrt((target * w) / h)));
    const rows = Math.max(1, Math.round(target / cols));
    const buckets: number[][] = [];
    const siteX = new Float32Array(target);
    const siteY = new Float32Array(target);
    for (let i = 0; i < target; i++) {
        siteX[i] = rand() * w;
        siteY[i] = rand() * h;
    }
    for (let i = 0; i < cols * rows; i++) {
        buckets.push([]);
    }
    for (let i = 0; i < target; i++) {
        const bx = Math.min(cols - 1, Math.floor((siteX[i] / w) * cols));
        const by = Math.min(rows - 1, Math.floor((siteY[i] / h) * rows));
        buckets[by * cols + bx].push(i);
    }
    const siteColor = new Float32Array(target * 4);
    const col = new Float32Array(4);
    for (let i = 0; i < target; i++) {
        sampleNearest(src, siteX[i], siteY[i], col);
        siteColor[i * 4] = col[0];
        siteColor[i * 4 + 1] = col[1];
        siteColor[i * 4 + 2] = col[2];
        siteColor[i * 4 + 3] = col[3];
    }
    const out = makeImageData(w, h);
    const d = out.data;
    const [er, eg, eb] = parseColor(edgeColor);
    const edgeW = clamp(edgeThickness, 0, 8);
    for (let y = 0; y < h; y++) {
        const by = Math.min(rows - 1, Math.floor((y / h) * rows));
        for (let x = 0; x < w; x++) {
            const bx = Math.min(cols - 1, Math.floor((x / w) * cols));
            let best = Number.POSITIVE_INFINITY;
            let second = Number.POSITIVE_INFINITY;
            let bestSite = -1;
            for (let ring = 0; ring <= 4 && bestSite < 0; ring++) {
                for (let oy = -ring; oy <= ring; oy++) {
                    const yy = by + oy;
                    if (yy < 0 || yy >= rows) {
                        continue;
                    }
                    for (let ox = -ring; ox <= ring; ox++) {
                        if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) {
                            continue;
                        }
                        const xx = bx + ox;
                        if (xx < 0 || xx >= cols) {
                            continue;
                        }
                        const list = buckets[yy * cols + xx];
                        for (let k = 0; k < list.length; k++) {
                            const site = list[k];
                            const dx = siteX[site] - x;
                            const dy = siteY[site] - y;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist < best) {
                                second = best;
                                best = dist;
                                bestSite = site;
                            } else if (dist < second) {
                                second = dist;
                            }
                        }
                    }
                }
            }
            const i = (y * w + x) * 4;
            if (bestSite >= 0) {
                d[i] = siteColor[bestSite * 4];
                d[i + 1] = siteColor[bestSite * 4 + 1];
                d[i + 2] = siteColor[bestSite * 4 + 2];
                d[i + 3] = siteColor[bestSite * 4 + 3];
                if (drawEdges && edgeW > 0 && second - best < edgeW) {
                    d[i] = er;
                    d[i + 1] = eg;
                    d[i + 2] = eb;
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

/** Monochrome halftone dots. */
export function halftone(
    src: ImageData,
    cellSize: number,
    dotSoftness: number,
    inkStrength: number,
    sourceBlend: number
): ImageData {
    const cell = Math.max(2, Math.round(clamp(cellSize, 2, 48)));
    const soft = Math.max(0.5, clamp(dotSoftness, 0, 100) / 20);
    const ink = clamp(inkStrength, 0, 100) / 100;
    const keep = clamp(sourceBlend, 0, 100) / 100;
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cx = (Math.floor(x / cell) + 0.5) * cell;
            const cy = (Math.floor(y / cell) + 0.5) * cell;
            const i = (y * w + x) * 4;
            const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
            const radius = (cell * 0.62) * Math.sqrt(1 - lum);
            const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
            const cov = 1 - clamp((dist - radius) / soft + 0.5, 0, 1);
            const amount = cov * ink;
            const inkR = s[i] * keep;
            const inkG = s[i + 1] * keep;
            const inkB = s[i + 2] * keep;
            d[i] = s[i] + (inkR - s[i]) * amount;
            d[i + 1] = s[i + 1] + (inkG - s[i + 1]) * amount;
            d[i + 2] = s[i + 2] + (inkB - s[i + 2]) * amount;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

function dotCoverage(x: number, y: number, cell: number, angle: number, value: number, soft: number): number {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = x * cos + y * sin;
    const ry = -x * sin + y * cos;
    const cx = (Math.floor(rx / cell) + 0.5) * cell;
    const cy = (Math.floor(ry / cell) + 0.5) * cell;
    const radius = cell * 0.62 * Math.sqrt(1 - clamp(value, 0, 1));
    const dist = Math.sqrt((rx - cx) * (rx - cx) + (ry - cy) * (ry - cy));
    return 1 - clamp((dist - radius) / soft + 0.5, 0, 1);
}

/** CMYK-style colour halftone (four rotated dot screens). */
export function colorHalftone(src: ImageData, size: number): ImageData {
    const cell = Math.max(2, Math.round(clamp(size, 2, 32)));
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const soft = cell * 0.18;
    const angles = [0.2618, 0.7854, 1.309, 0];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = s[i] / 255;
            const g = s[i + 1] / 255;
            const b = s[i + 2] / 255;
            const c = 1 - r;
            const m = 1 - g;
            const yk = 1 - b;
            const k = Math.min(c, m, yk);
            const cc = c - k;
            const mm = m - k;
            const yy = yk - k;
            const covC = dotCoverage(x, y, cell, angles[0], cc, soft);
            const covM = dotCoverage(x, y, cell, angles[1], mm, soft);
            const covY = dotCoverage(x, y, cell, angles[2], yy, soft);
            const covK = dotCoverage(x, y, cell, angles[3], k, soft);
            d[i] = clamp255(255 * (1 - covC * 0.85 - covK));
            d[i + 1] = clamp255(255 * (1 - covM * 0.85 - covK));
            d[i + 2] = clamp255(255 * (1 - covY * 0.85 - covK));
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Dot matrix: coloured dots on a paper background. */
export function dotMatrix(
    src: ImageData,
    cellSize: number,
    dotScale: number,
    colorMode: boolean,
    dotColor: string,
    paperColor: string
): ImageData {
    const cell = Math.max(2, Math.round(clamp(cellSize, 2, 32)));
    const scale = clamp(dotScale, 0.1, 1.5);
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const [pr, pg, pb] = parseColor(paperColor);
    const [dr, dg, db] = parseColor(dotColor);
    const radius = (cell / 2) * scale;
    const radiusSq = radius * radius;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cx = (Math.floor(x / cell) + 0.5) * cell;
            const cy = (Math.floor(y / cell) + 0.5) * cell;
            const i = (y * w + x) * 4;
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy <= radiusSq) {
                d[i] = colorMode ? s[i] : dr;
                d[i + 1] = colorMode ? s[i + 1] : dg;
                d[i + 2] = colorMode ? s[i + 2] : db;
                d[i + 3] = 255;
            } else {
                d[i] = pr;
                d[i + 1] = pg;
                d[i + 2] = pb;
                d[i + 3] = 255;
            }
        }
    }
    return out;
}

export type DitherMethod = "FloydSteinberg" | "Bayer4x4";
export type DitherPalette = "OneBitBW" | "WebSafe216" | "RGB332" | "Grayscale4";

function nearestPalette(r: number, g: number, b: number, palette: DitherPalette, out: Float32Array): void {
    if (palette === "OneBitBW") {
        const v = luminance(r, g, b) >= 128 ? 255 : 0;
        out[0] = v;
        out[1] = v;
        out[2] = v;
    } else if (palette === "Grayscale4") {
        const v = Math.round(luminance(r, g, b) / 85) * 85;
        out[0] = v;
        out[1] = v;
        out[2] = v;
    } else if (palette === "RGB332") {
        out[0] = Math.round(r / 36.4) * 36.4;
        out[1] = Math.round(g / 36.4) * 36.4;
        out[2] = Math.round(b / 85) * 85;
    } else {
        out[0] = Math.round(r / 51) * 51;
        out[1] = Math.round(g / 51) * 51;
        out[2] = Math.round(b / 51) * 51;
    }
}

/** Error-diffusion or ordered dithering with a selectable palette. */
export function dithering(
    src: ImageData,
    method: DitherMethod,
    palette: DitherPalette,
    serpentine: boolean,
    strength: number
): ImageData {
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const mix = clamp(strength, 0, 100) / 100;
    const pal = new Float32Array(3);
    if (method === "Bayer4x4") {
        const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const thr = (matrix[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 64;
                nearestPalette(s[i] + thr, s[i + 1] + thr, s[i + 2] + thr, palette, pal);
                d[i] = s[i] + (pal[0] - s[i]) * mix;
                d[i + 1] = s[i + 1] + (pal[1] - s[i + 1]) * mix;
                d[i + 2] = s[i + 2] + (pal[2] - s[i + 2]) * mix;
                d[i + 3] = s[i + 3];
            }
        }
        return out;
    }
    const work = new Float32Array(w * h * 3);
    for (let i = 0, p = 0; i < s.length; i += 4, p += 3) {
        work[p] = s[i];
        work[p + 1] = s[i + 1];
        work[p + 2] = s[i + 2];
    }
    for (let y = 0; y < h; y++) {
        const reverse = serpentine && y % 2 === 1;
        for (let step = 0; step < w; step++) {
            const x = reverse ? w - 1 - step : step;
            const p = (y * w + x) * 3;
            const r = work[p];
            const g = work[p + 1];
            const b = work[p + 2];
            nearestPalette(r, g, b, palette, pal);
            const i = (y * w + x) * 4;
            d[i] = s[i] + (pal[0] - s[i]) * mix;
            d[i + 1] = s[i + 1] + (pal[1] - s[i + 1]) * mix;
            d[i + 2] = s[i + 2] + (pal[2] - s[i + 2]) * mix;
            d[i + 3] = s[i + 3];
            if (mix <= 0) {
                continue;
            }
            const er = (r - pal[0]) * mix;
            const eg = (g - pal[1]) * mix;
            const eb = (b - pal[2]) * mix;
            const dir = reverse ? -1 : 1;
            const nx1 = x + dir;
            if (nx1 >= 0 && nx1 < w) {
                const np = (y * w + nx1) * 3;
                work[np] += (er * 7) / 16;
                work[np + 1] += (eg * 7) / 16;
                work[np + 2] += (eb * 7) / 16;
            }
            if (y + 1 < h) {
                const nx2 = x - dir;
                if (nx2 >= 0 && nx2 < w) {
                    const np2 = ((y + 1) * w + nx2) * 3;
                    work[np2] += (er * 3) / 16;
                    work[np2 + 1] += (eg * 3) / 16;
                    work[np2 + 2] += (eb * 3) / 16;
                }
                const np3 = ((y + 1) * w + x) * 3;
                work[np3] += (er * 5) / 16;
                work[np3 + 1] += (eg * 5) / 16;
                work[np3 + 2] += (eb * 5) / 16;
                const nx4 = x + dir;
                if (nx4 >= 0 && nx4 < w) {
                    const np4 = ((y + 1) * w + nx4) * 3;
                    work[np4] += er / 16;
                    work[np4 + 1] += eg / 16;
                    work[np4 + 2] += eb / 16;
                }
            }
        }
    }
    return out;
}

/** Maps each channel onto a coarse palette ramp. */
export function paletteMap(src: ImageData, levels: number): ImageData {
    const n = Math.max(2, Math.round(clamp(levels, 2, 64)));
    const out = makeImageData(src.width, src.height);
    const d = out.data;
    const s = src.data;
    const step = 255 / (n - 1);
    for (let i = 0; i < s.length; i += 4) {
        d[i] = Math.round(s[i] / step) * step;
        d[i + 1] = Math.round(s[i + 1] / step) * step;
        d[i + 2] = Math.round(s[i + 2] / step) * step;
        d[i + 3] = s[i + 3];
    }
    return out;
}

/** Quantises channels to `bitsPerChannel` bits. */
export function colorDepth(src: ImageData, bitsPerChannel: number): ImageData {
    const bits = Math.round(clamp(bitsPerChannel, 1, 8));
    const levels = (1 << bits) - 1;
    const out = makeImageData(src.width, src.height);
    const d = out.data;
    const s = src.data;
    for (let i = 0; i < s.length; i += 4) {
        d[i] = Math.round((s[i] / 255) * levels) * (255 / levels);
        d[i + 1] = Math.round((s[i + 1] / 255) * levels) * (255 / levels);
        d[i + 2] = Math.round((s[i + 2] / 255) * levels) * (255 / levels);
        d[i + 3] = s[i + 3];
    }
    return out;
}

function integralRect(
    table: Float32Array,
    stride: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
): number {
    const a = table[y0 * stride + x0];
    const b = table[y0 * stride + x1];
    const c = table[y1 * stride + x0];
    const d = table[y1 * stride + x1];
    return d - b - c + a;
}

/** Kuwahara watercolour filter using summed-area statistics. */
export function kuwahara(src: ImageData, radius: number, saturationBoost = 20, detailBlend = 18): ImageData {
    const r = Math.round(clamp(radius, 1, 12));
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const stride = w + 1;
    const size = (w + 1) * (h + 1);
    const iR = new Float32Array(size);
    const iG = new Float32Array(size);
    const iB = new Float32Array(size);
    const iL = new Float32Array(size);
    const iL2 = new Float32Array(size);
    for (let y = 0; y < h; y++) {
        let rowR = 0;
        let rowG = 0;
        let rowB = 0;
        let rowL = 0;
        let rowL2 = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
            rowR += s[i];
            rowG += s[i + 1];
            rowB += s[i + 2];
            rowL += lum;
            rowL2 += lum * lum;
            const idx = (y + 1) * stride + x + 1;
            iR[idx] = iR[idx - stride] + rowR;
            iG[idx] = iG[idx - stride] + rowG;
            iB[idx] = iB[idx - stride] + rowB;
            iL[idx] = iL[idx - stride] + rowL;
            iL2[idx] = iL2[idx - stride] + rowL2;
        }
    }
    const out = makeImageData(w, h);
    const d = out.data;
    const sat = 1 + clamp(saturationBoost, -100, 100) / 100;
    const detail = clamp(detailBlend, 0, 100) / 100;
    const rects: number[][] = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - r);
            const x1 = Math.min(w, x + r + 1);
            const y0 = Math.max(0, y - r);
            const y1 = Math.min(h, y + r + 1);
            const midX = Math.min(Math.max(x, x0), x1);
            const midY = Math.min(Math.max(y, y0), y1);
            rects[0][0] = x0;
            rects[0][1] = y0;
            rects[0][2] = midX;
            rects[0][3] = midY;
            rects[1][0] = midX;
            rects[1][1] = y0;
            rects[1][2] = x1;
            rects[1][3] = midY;
            rects[2][0] = x0;
            rects[2][1] = midY;
            rects[2][2] = midX;
            rects[2][3] = y1;
            rects[3][0] = midX;
            rects[3][1] = midY;
            rects[3][2] = x1;
            rects[3][3] = y1;
            let bestVar = Number.POSITIVE_INFINITY;
            let bestRect = rects[0];
            let bestArea = 1;
            for (let q = 0; q < 4; q++) {
                const rect = rects[q];
                const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
                if (area <= 0) {
                    continue;
                }
                const lumSum = integralRect(iL, stride, rect[0], rect[1], rect[2], rect[3]);
                const lumSq = integralRect(iL2, stride, rect[0], rect[1], rect[2], rect[3]);
                const mean = lumSum / area;
                const variance = Math.max(0, lumSq / area - mean * mean);
                if (variance < bestVar) {
                    bestVar = variance;
                    bestRect = rect;
                    bestArea = area;
                }
            }
            const rAvg = integralRect(iR, stride, bestRect[0], bestRect[1], bestRect[2], bestRect[3]) / bestArea;
            const gAvg = integralRect(iG, stride, bestRect[0], bestRect[1], bestRect[2], bestRect[3]) / bestArea;
            const bAvg = integralRect(iB, stride, bestRect[0], bestRect[1], bestRect[2], bestRect[3]) / bestArea;
            const i = (y * w + x) * 4;
            const lum = luminance(rAvg, gAvg, bAvg);
            const nr = lum + (rAvg - lum) * sat;
            const ng = lum + (gAvg - lum) * sat;
            const nb = lum + (bAvg - lum) * sat;
            d[i] = clamp255(nr + (s[i] - nr) * detail);
            d[i + 1] = clamp255(ng + (s[i + 1] - ng) * detail);
            d[i + 2] = clamp255(nb + (s[i + 2] - nb) * detail);
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Oil-paint filter: dominant intensity bin inside a circular brush. */
export function oilPaint(src: ImageData, radius: number, levels: number): ImageData {
    const r = Math.round(clamp(radius, 1, 10));
    const bins = Math.round(clamp(levels, 4, 64));
    const w = src.width;
    const h = src.height;
    const s = src.data;
    const out = makeImageData(w, h);
    const d = out.data;
    const counts = new Uint16Array(bins);
    const sumR = new Float32Array(bins);
    const sumG = new Float32Array(bins);
    const sumB = new Float32Array(bins);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            counts.fill(0);
            sumR.fill(0);
            sumG.fill(0);
            sumB.fill(0);
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
                    const bin = Math.min(bins - 1, Math.floor((luminance(s[si], s[si + 1], s[si + 2]) / 256) * bins));
                    counts[bin]++;
                    sumR[bin] += s[si];
                    sumG[bin] += s[si + 1];
                    sumB[bin] += s[si + 2];
                }
            }
            let best = 0;
            for (let b = 1; b < bins; b++) {
                if (counts[b] > counts[best]) {
                    best = b;
                }
            }
            const n = counts[best] || 1;
            const i = (y * w + x) * 4;
            d[i] = sumR[best] / n;
            d[i + 1] = sumG[best] / n;
            d[i + 2] = sumB[best] / n;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Layered crosshatch shading. */
export function crosshatch(
    src: ImageData,
    lineSpacing: number,
    lineThickness: number,
    contrast: number,
    layerCount: number
): ImageData {
    const spacing = Math.max(2, lineSpacing);
    const thickness = Math.max(0.5, lineThickness);
    const layers = Math.max(1, Math.round(clamp(layerCount, 1, 8)));
    const gain = clamp(contrast, 1, 300) / 100;
    const w = src.width;
    const h = src.height;
    const out = cloneImageData(src);
    const d = out.data;
    const s = src.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
            const darkness = clamp((1 - lum) * gain, 0, 1);
            let ink = 0;
            for (let layer = 0; layer < layers; layer++) {
                const threshold = (layer + 1) / (layers + 1);
                if (darkness < threshold) {
                    continue;
                }
                const angle = (Math.PI / 4) * (layer + 1);
                const phase = (x * Math.cos(angle) + y * Math.sin(angle)) / spacing;
                const local = phase - Math.floor(phase);
                if (local * spacing < thickness) {
                    ink = 1;
                }
            }
            if (ink > 0) {
                d[i] = s[i] * 0.12;
                d[i + 1] = s[i + 1] * 0.12;
                d[i + 2] = s[i + 2] * 0.12;
            }
        }
    }
    return out;
}

/** Engraving / line shading on paper. */
export function engraving(
    src: ImageData,
    lineSpacing: number,
    angle: number,
    lineWidthMax: number,
    lineColor: string,
    paperColor: string
): ImageData {
    const spacing = Math.max(2, lineSpacing);
    const widthMax = Math.max(0.2, lineWidthMax);
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const [lr, lg, lb] = parseColor(lineColor);
    const [pr, pg, pb] = parseColor(paperColor);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = luminance(s[i], s[i + 1], s[i + 2]) / 255;
            const phase = (x * cos + y * sin) / spacing;
            const local = phase - Math.floor(phase);
            const lw = widthMax * (1 - lum);
            const ink = local * spacing < lw ? 1 : 0;
            d[i] = pr + (lr - pr) * ink;
            d[i + 1] = pg + (lg - pg) * ink;
            d[i + 2] = pb + (lb - pb) * ink;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

export interface AsciiGrid {
    rows: string[];
    columns: number;
    rowsCount: number;
    cell: number;
}

/** Pure helper: maps block luminance to a character grid for ASCII rendering. */
export function asciiGrid(
    src: ImageData,
    cellSize: number,
    contrast: number,
    charset: string,
    invert: boolean,
    darkBackground: boolean
): AsciiGrid {
    const cell = Math.max(2, Math.round(clamp(cellSize, 2, 64)));
    const chars = charset && charset.length > 0 ? charset : "@%#*+=-:. ";
    const gain = clamp(contrast, 1, 300) / 100;
    const cols = Math.max(1, Math.floor(src.width / cell));
    const rows = Math.max(1, Math.floor(src.height / cell));
    const lines: string[] = [];
    const avg = new Float32Array(4);
    for (let ry = 0; ry < rows; ry++) {
        let line = "";
        for (let rx = 0; rx < cols; rx++) {
            averageBlock(src, rx * cell, ry * cell, (rx + 1) * cell, (ry + 1) * cell, avg);
            let lum = (0.299 * avg[0] + 0.587 * avg[1] + 0.114 * avg[2]) / 255;
            lum = clamp((lum - 0.5) * gain + 0.5, 0, 1);
            if (invert) {
                lum = 1 - lum;
            }
            const mapped = darkBackground ? 1 - lum : lum;
            const idx = Math.min(chars.length - 1, Math.max(0, Math.floor(mapped * (chars.length - 1) + 0.5)));
            line += chars[idx];
        }
        lines.push(line);
    }
    return { rows: lines, columns: cols, rowsCount: rows, cell };
}

/** Darkens alternating scanlines. */
export function scanlines(src: ImageData, spacing: number, opacity: number): ImageData {
    const gap = Math.max(1, Math.round(clamp(spacing, 1, 32)));
    const amount = clamp(opacity, 0, 100) / 100;
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    for (let y = 0; y < h; y++) {
        const f = y % gap === 0 ? 1 - amount : 1;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            d[i] = s[i] * f;
            d[i + 1] = s[i + 1] * f;
            d[i + 2] = s[i + 2] * f;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Shifts red/blue channels horizontally (glitch / CRT). */
export function channelShift(src: ImageData, amount: number): ImageData {
    const shift = Math.round(clamp(amount, -40, 40));
    const w = src.width;
    const h = src.height;
    const out = cloneImageData(src);
    const d = out.data;
    const s = src.data;
    if (shift === 0) {
        return out;
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const rx = clamp(x - shift, 0, w - 1);
            const bx = clamp(x + shift, 0, w - 1);
            d[i] = s[(y * w + rx) * 4];
            d[i + 2] = s[(y * w + bx) * 4 + 2];
        }
    }
    return out;
}

/** CRT helper: chroma shift, scanlines, noise and vignette. */
export function crt(
    src: ImageData,
    scanlineStrength: number,
    rgbShift: number,
    noiseAmount: number,
    vignetteStrength: number,
    seed = 1
): ImageData {
    let data = channelShift(src, rgbShift);
    data = scanlines(data, 3, scanlineStrength);
    data = filmGrain(data, noiseAmount, true, seed);
    return vignette(data, 0.45, vignetteStrength / 100);
}

/** Random horizontal band displacement. */
export function bandShift(src: ImageData, bands: number, maxShift: number, seed = 1): ImageData {
    const count = Math.max(1, Math.round(clamp(bands, 1, 120)));
    const limit = clamp(maxShift, 0, 200);
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const rand = mulberry32(deriveSeed(seed, "band"));
    const bandH = Math.max(1, Math.floor(h / count));
    for (let by = 0; by < h; by += bandH) {
        const offset = Math.round((rand() * 2 - 1) * limit);
        const end = Math.min(h, by + bandH);
        for (let y = by; y < end; y++) {
            for (let x = 0; x < w; x++) {
                const sx = x + offset;
                const i = (y * w + x) * 4;
                if (sx >= 0 && sx < w) {
                    const si = (y * w + sx) * 4;
                    d[i] = s[si];
                    d[i + 1] = s[si + 1];
                    d[i + 2] = s[si + 2];
                    d[i + 3] = s[si + 3];
                } else {
                    d[i] = 0;
                    d[i + 1] = 0;
                    d[i + 2] = 0;
                    d[i + 3] = 0;
                }
            }
        }
    }
    return out;
}

/** Sorts thresholded pixel spans by brightness or hue. */
export function pixelSort(
    src: ImageData,
    direction: "Horizontal" | "Vertical",
    metric: "Brightness" | "Hue",
    thresholdLow: number,
    thresholdHigh: number,
    minSpanLength: number,
    maxSpanLength: number,
    probability: number,
    seed = 1
): ImageData {
    const w = src.width;
    const h = src.height;
    const out = cloneImageData(src);
    const d = out.data;
    const s = src.data;
    const low = clamp(thresholdLow, 0, 255);
    const high = clamp(thresholdHigh, 0, 255);
    const minSpan = Math.max(1, Math.round(clamp(minSpanLength, 1, 200)));
    const maxSpan = Math.max(minSpan, Math.round(clamp(maxSpanLength, 1, 1000)));
    const chance = clamp(probability, 0, 100) / 100;
    const rand = mulberry32(deriveSeed(seed, "sort"));
    const metrics = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (metric === "Hue") {
                const r = s[i] / 255;
                const g = s[i + 1] / 255;
                const b = s[i + 2] / 255;
                const mx = Math.max(r, g, b);
                const mn = Math.min(r, g, b);
                const delta = mx - mn;
                let hue = 0;
                if (delta > 0.00001) {
                    if (mx === r) {
                        hue = ((g - b) / delta) % 6;
                    } else if (mx === g) {
                        hue = (b - r) / delta + 2;
                    } else {
                        hue = (r - g) / delta + 4;
                    }
                    hue /= 6;
                    if (hue < 0) {
                        hue += 1;
                    }
                }
                metrics[y * w + x] = hue * 255;
            } else {
                metrics[y * w + x] = luminance(s[i], s[i + 1], s[i + 2]);
            }
        }
    }
    const horizontal = direction === "Horizontal";
    const length = horizontal ? h : w;
    const lineLength = horizontal ? w : h;
    const indices: number[] = [];
    const keys: number[] = [];
    const inRange = (t: number, line: number): boolean => {
        const x = horizontal ? t : line;
        const y = horizontal ? line : t;
        const m = metrics[y * w + x];
        return m >= low && m <= high;
    };
    for (let line = 0; line < length; line++) {
        let pos = 0;
        while (pos < lineLength) {
            if (!inRange(pos, line)) {
                pos++;
                continue;
            }
            let end = pos;
            while (end < lineLength && inRange(end, line) && end - pos < maxSpan) {
                end++;
            }
            const span = end - pos;
            if (span >= minSpan && rand() <= chance) {
                indices.length = 0;
                keys.length = 0;
                for (let t = pos; t < end; t++) {
                    const x = horizontal ? t : line;
                    const y = horizontal ? line : t;
                    indices.push((y * w + x) * 4);
                    keys.push(metrics[y * w + x]);
                }
                const order = indices.map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
                for (let k = 0; k < order.length; k++) {
                    const from = indices[order[k]];
                    const to = indices[k];
                    d[to] = s[from];
                    d[to + 1] = s[from + 1];
                    d[to + 2] = s[from + 2];
                    d[to + 3] = s[from + 3];
                }
            }
            pos = end;
        }
    }
    return out;
}

/** Adds monochrome or coloured film grain. */
export function filmGrain(src: ImageData, amount: number, monochrome = true, seed = 1): ImageData {
    const strength = (clamp(amount, 0, 100) / 100) * 96;
    if (strength <= 0) {
        return cloneImageData(src);
    }
    const rand = mulberry32(deriveSeed(seed, "grain"));
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (monochrome) {
                const n = (rand() * 2 - 1) * strength;
                d[i] = clamp255(s[i] + n);
                d[i + 1] = clamp255(s[i + 1] + n);
                d[i + 2] = clamp255(s[i + 2] + n);
            } else {
                d[i] = clamp255(s[i] + (rand() * 2 - 1) * strength);
                d[i + 1] = clamp255(s[i + 1] + (rand() * 2 - 1) * strength);
                d[i + 2] = clamp255(s[i + 2] + (rand() * 2 - 1) * strength);
            }
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}

/** Radial vignette; strength 0..1, radius 0..1. */
export function vignette(src: ImageData, strength: number, radius = 0.75): ImageData {
    const amt = clamp(strength, 0, 1);
    const falloff = clamp(radius, 0.01, 2);
    const w = src.width;
    const h = src.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.sqrt(cx * cx + cy * cy);
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy) / maxR;
            const t = clamp((dist - falloff) / Math.max(0.001, 1 - falloff), 0, 1);
            const f = 1 - amt * t * t;
            const i = (y * w + x) * 4;
            d[i] = s[i] * f;
            d[i + 1] = s[i + 1] * f;
            d[i + 2] = s[i + 2] * f;
            d[i + 3] = s[i + 3];
        }
    }
    return out;
}
