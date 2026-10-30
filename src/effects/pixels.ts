/** Minimal pixel helpers that work in the browser and in Node tests. */

/** Creates an ImageData-like buffer (Node has no ImageData global). */
export function makeImageData(width: number, height: number): ImageData {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (typeof ImageData !== "undefined") {
        return new ImageData(w, h);
    }
    return {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
        colorSpace: "srgb",
    } as unknown as ImageData;
}

export function cloneImageData(src: ImageData): ImageData {
    const out = makeImageData(src.width, src.height);
    out.data.set(src.data);
    return out;
}

export function clamp255(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** "#RRGGBB" / "#RRGGBBAA" / "#RGB" → [r,g,b,a]. */
export function parseColor(value: string): [number, number, number, number] {
    let hex = (value || "#000000").trim().replace(/^#/, "");
    if (hex.length === 3) {
        hex = hex.split("").map((ch) => ch + ch).join("");
    }
    if (hex.length === 8) {
        return [
            parseInt(hex.slice(0, 2), 16) || 0,
            parseInt(hex.slice(2, 4), 16) || 0,
            parseInt(hex.slice(4, 6), 16) || 0,
            parseInt(hex.slice(6, 8), 16) || 0,
        ];
    }
    if (hex.length !== 6) {
        return [0, 0, 0, 255];
    }
    return [
        parseInt(hex.slice(0, 2), 16) || 0,
        parseInt(hex.slice(2, 4), 16) || 0,
        parseInt(hex.slice(4, 6), 16) || 0,
        255,
    ];
}

export function toHex(r: number, g: number, b: number, a = 255): string {
    const hex = [r, g, b].map((v) => Math.round(clamp255(v)).toString(16).padStart(2, "0")).join("").toUpperCase();
    if (a >= 255) {
        return `#${hex}`;
    }
    return `#${hex}${Math.round(clamp255(a)).toString(16).padStart(2, "0").toUpperCase()}`;
}

export function luminance(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge0 === edge1) {
        return x < edge0 ? 0 : 1;
    }
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export function clamp(value: number, lo: number, hi: number): number {
    return value < lo ? lo : value > hi ? hi : value;
}
