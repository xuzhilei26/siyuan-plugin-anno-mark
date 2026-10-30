/**
 * Frame helpers. Frames are the only place a real 2D canvas is used: withFrame
 * creates a DOM canvas when available, otherwise it degrades to plain padding.
 */
import { clamp, clamp255, makeImageData, parseColor } from "../pixels.ts";
import type { Insets, ParamDict } from "../types.ts";
import { mulberry32 } from "../rand.ts";
import { paintTexture, valueNoise2D } from "./textures.ts";

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Grows the canvas by `pad` and returns the content rectangle. */
export function expand(
    src: ImageData,
    pad: Insets
): { data: ImageData; content: Rect } {
    const top = Math.max(0, Math.round(pad.top));
    const right = Math.max(0, Math.round(pad.right));
    const bottom = Math.max(0, Math.round(pad.bottom));
    const left = Math.max(0, Math.round(pad.left));
    const w = src.width + left + right;
    const h = src.height + top + bottom;
    const out = makeImageData(w, h);
    const d = out.data;
    const s = src.data;
    const rowBytes = src.width * 4;
    for (let y = 0; y < src.height; y++) {
        d.set(s.subarray(y * rowBytes, (y + 1) * rowBytes), ((y + top) * w + left) * 4);
    }
    return { data: out, content: { x: left, y: top, w: src.width, h: src.height } };
}

export interface FrameSurface {
    ctx: CanvasRenderingContext2D;
    rect: Rect;
    width: number;
    height: number;
}

/**
 * Expands by pad, then lets `paint` decorate the frame on a real canvas.
 * In Node (no document) the expanded pixels are returned unchanged.
 */
export function withFrame(
    src: ImageData,
    pad: Insets,
    paint?: (surface: FrameSurface) => void
): ImageData {
    const expanded = expand(src, pad);
    if (!paint || typeof document === "undefined") {
        return expanded.data;
    }
    const canvas = document.createElement("canvas");
    canvas.width = expanded.data.width;
    canvas.height = expanded.data.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return expanded.data;
    }
    ctx.putImageData(expanded.data, 0, 0);
    paint({ ctx, rect: expanded.content, width: canvas.width, height: canvas.height });
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function num(params: ParamDict, key: string, fallback: number): number {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(params: ParamDict, key: string, fallback: string): string {
    const value = params[key];
    return typeof value === "string" ? value : fallback;
}

function bool(params: ParamDict, key: string, fallback: boolean): boolean {
    const value = params[key];
    return typeof value === "boolean" ? value : fallback;
}

/** Border pattern identifiers used by the frame painters. */
export type BorderKind =
    | "solid"
    | "gradient"
    | "double"
    | "neon"
    | "rainbow"
    | "zigzag"
    | "wave"
    | "brick"
    | "candy"
    | "celtic"
    | "chain"
    | "circuit"
    | "marble"
    | "mosaic"
    | "rope"
    | "stained"
    | "starfield"
    | "watercolor"
    | "wooden"
    | "frost"
    | "lava"
    | "ornate"
    | "artdeco"
    | "chrome"
    | "golden"
    | "crimson"
    | "filmstrip"
    | "polaroid"
    | "macos"
    | "windows11"
    | "torn"
    | "waveEdge"
    | "cartoon"
    | "stencil";

function ringPath(ctx: CanvasRenderingContext2D, rect: Rect, w: number, h: number): void {
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip("evenodd");
}

function fillRing(ctx: CanvasRenderingContext2D, rect: Rect, color: string): void {
    ctx.save();
    ringPath(ctx, rect, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
}

function traceRoundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number
): void {
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function paintWesternBand(
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    w: number,
    h: number,
    sides: { top: boolean; right: boolean; bottom: boolean; left: boolean },
    depth: number,
    color: string,
    accent: string,
    zig: boolean
): void {
    ctx.save();
    ringPath(ctx, rect, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    const step = Math.max(6, depth / 3);
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, depth / 12);
    ctx.beginPath();
    if (sides.top) {
        for (let x = 0; x <= w; x += step) {
            const y = rect.y - depth + (zig ? (x / step) % 2 === 0 ? 0 : depth : Math.sin(x / step) * depth * 0.5);
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    if (sides.right) {
        for (let y = 0; y <= h; y += step) {
            const x = rect.x + rect.w + depth - (zig ? (y / step) % 2 === 0 ? 0 : depth : Math.sin(y / step) * depth * 0.5);
            if (y === 0 && !sides.top) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    if (sides.bottom) {
        for (let x = w; x >= 0; x -= step) {
            const y = rect.y + rect.h + depth - (zig ? (x / step) % 2 === 0 ? 0 : depth : Math.sin(x / step) * depth * 0.5);
            if (x === w && !sides.right) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    if (sides.left) {
        for (let y = h; y >= 0; y -= step) {
            const x = rect.x - depth + (zig ? (y / step) % 2 === 0 ? 0 : depth : Math.sin(y / step) * depth * 0.5);
            if (y === h && !sides.bottom) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    ctx.stroke();
    ctx.restore();
}

/**
 * Single entry point for every border painter. The border lies outside `rect`.
 * Colours fall back to sensible per-kind palettes.
 */
export function paintBorderPattern(
    kind: BorderKind,
    params: ParamDict,
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    seed = 1
): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const border = Math.max(1, num(params, "border_size", num(params, "size", num(params, "border_width", 32))));
    const rand = mulberry32(seed + 7);
    ctx.save();
    switch (kind) {
        case "solid": {
            fillRing(ctx, rect, str(params, "color", "#000000"));
            break;
        }
        case "gradient": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, str(params, "outer_color", "#0A0A23"));
            g.addColorStop(clamp(num(params, "mid_position", 50) / 100, 0.05, 0.95), str(params, "mid_color", "#3C1478"));
            g.addColorStop(1, str(params, "inner_color", "#B450C8"));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
            break;
        }
        case "double": {
            fillRing(ctx, rect, str(params, "color", "#222222"));
            ctx.strokeStyle = str(params, "color2", str(params, "accent_color", "#D4AF37"));
            ctx.lineWidth = Math.max(1, border / 8);
            ctx.strokeRect(rect.x - border * 0.18, rect.y - border * 0.18, rect.w + border * 0.36, rect.h + border * 0.36);
            ctx.strokeRect(rect.x - border * 0.62, rect.y - border * 0.62, rect.w + border * 1.24, rect.h + border * 1.24);
            break;
        }
        case "neon": {
            fillRing(ctx, rect, str(params, "bg_color", "#0A0A12"));
            const tube = Math.max(1, num(params, "tube_width", 4));
            const neon = str(params, "neon_color", "#00FFC8");
            ctx.strokeStyle = neon;
            ctx.lineWidth = tube;
            ctx.shadowColor = neon;
            ctx.shadowBlur = clamp(num(params, "glow_intensity", 75) / 3, 0, 40);
            ctx.strokeRect(rect.x - border / 2, rect.y - border / 2, rect.w + border, rect.h + border);
            if (bool(params, "double_tube", false)) {
                ctx.strokeRect(rect.x - border * 0.82, rect.y - border * 0.82, rect.w + border * 1.64, rect.h + border * 1.64);
            }
            break;
        }
        case "rainbow": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            const cx = rect.x + rect.w / 2;
            const cy = rect.y + rect.h / 2;
            const sat = clamp(num(params, "saturation", 100), 0, 100);
            const light = clamp(num(params, "brightness", 95) / 2, 20, 70);
            const offset = num(params, "hue_offset", 0);
            const segments = 180;
            for (let i = 0; i < segments; i++) {
                const a0 = (i / segments) * Math.PI * 2;
                const a1 = ((i + 1) / segments) * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, Math.max(w, h), a0, a1);
                ctx.closePath();
                ctx.fillStyle = `hsl(${offset + (i / segments) * 360}, ${sat}%, ${light}%)`;
                ctx.fill();
            }
            ctx.restore();
            if (bool(params, "inner_line", true)) {
                ctx.strokeStyle = "rgba(255,255,255,0.65)";
                ctx.lineWidth = 2;
                ctx.strokeRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);
            }
            break;
        }
        case "zigzag": {
            const depth = Math.max(2, num(params, "teeth_height", 40) / 2 + border / 4);
            paintWesternBand(ctx, rect, w, h, { top: true, right: true, bottom: true, left: true }, depth, str(params, "frame_color", "#282832"), str(params, "accent_color", "#DCB43C"), true);
            break;
        }
        case "wave":
        case "waveEdge": {
            const depth = Math.max(2, num(params, "depth", 15));
            paintWesternBand(ctx, rect, w, h, {
                top: bool(params, "top", true),
                right: bool(params, "right", true),
                bottom: bool(params, "bottom", true),
                left: bool(params, "left", true),
            }, depth, str(params, "frame_color", "#1E2A44"), str(params, "color", "#FFFFFF"), false);
            break;
        }
        case "brick": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "mortar_color", "#C3BCAF");
            ctx.fillRect(0, 0, w, h);
            const bh = Math.max(6, border / 3);
            const bw = Math.max(10, border / 1.5);
            const variation = clamp(num(params, "color_variation", 40) / 100, 0, 1);
            const mortar = str(params, "mortar_color", "#C3BCAF");
            const brickBase = str(params, "brick_color", "#B25A3E");
            ctx.fillStyle = brickBase;
            let row = 0;
            for (let y = -bh; y < h + bh; y += bh, row++) {
                const offset = row % 2 === 0 ? 0 : -bw / 2;
                for (let x = -bw; x < w + bw; x += bw) {
                    const bx = x + offset + 2;
                    const by = y + 2;
                    const t = 0.8 + rand() * variation * 0.4;
                    ctx.fillStyle = t > 1 ? brickBase : `rgba(0,0,0,${(1 - t) * 0.25})`;
                    ctx.fillRect(bx, by, bw - 4, bh - 4);
                    if (rand() > 0.5) {
                        ctx.fillStyle = "rgba(255,255,255,0.08)";
                        ctx.fillRect(bx, by, bw - 4, 1);
                    }
                }
            }
            void mortar;
            ctx.restore();
            break;
        }
        case "candy": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "color_a", "#DC1414");
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = str(params, "color_b", "#FFFFFF");
            const stripe = Math.max(2, num(params, "stripe_width", 12));
            ctx.lineWidth = stripe;
            ctx.beginPath();
            for (let x = -h; x < w + h; x += stripe * 2) {
                ctx.moveTo(x, 0);
                ctx.lineTo(x + h, h);
            }
            ctx.stroke();
            ctx.restore();
            break;
        }
        case "celtic": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "bg_color", "#233719");
            ctx.fillRect(0, 0, w, h);
            const strand = Math.max(1, num(params, "strand_width", 35) / 16);
            ctx.strokeStyle = str(params, "knot_color", "#B48C3C");
            ctx.lineWidth = strand;
            const mid = border / 2;
            ctx.beginPath();
            for (let x = 0; x <= w; x += 6) {
                const y = rect.y - mid + Math.sin(x / 18) * mid * 0.7;
                if (x === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
            ctx.beginPath();
            for (let x = 0; x <= w; x += 6) {
                const y = rect.y - mid + Math.sin(x / 18 + Math.PI) * mid * 0.7;
                if (x === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
            ctx.restore();
            break;
        }
        case "chain": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "bg_color", "#232830");
            ctx.fillRect(0, 0, w, h);
            const cell = Math.max(6, num(params, "cell_size", 20));
            const wire = Math.max(1, num(params, "wire_width", 2.5));
            ctx.strokeStyle = str(params, "wire_color", "#AAAFB4");
            ctx.lineWidth = wire;
            let flip = false;
            for (let x = 0; x < w; x += cell) {
                ctx.beginPath();
                const y = rect.y - border / 2;
                if (flip) {
                    ctx.ellipse(x + cell / 2, y, cell * 0.34, border * 0.3, 0, 0, Math.PI * 2);
                } else {
                    ctx.ellipse(x + cell / 2, y, cell * 0.34, border * 0.3, 0, 0, Math.PI * 2);
                }
                ctx.stroke();
                flip = !flip;
            }
            ctx.restore();
            break;
        }
        case "circuit": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "board_color", "#0C3A20");
            ctx.fillRect(0, 0, w, h);
            const trace = str(params, "trace_color", "#B87333");
            ctx.strokeStyle = trace;
            ctx.lineWidth = 1.5;
            if (bool(params, "glow", true)) {
                ctx.shadowColor = trace;
                ctx.shadowBlur = 6;
            }
            const density = Math.round(clamp(num(params, "trace_density", 55), 0, 100) / 6);
            for (let i = 0; i < density; i++) {
                const horizontal = rand() > 0.5;
                const start = rand() * (horizontal ? w : h);
                const end = rand() * (horizontal ? w : h);
                const outer = horizontal ? (rand() > 0.5 ? 0 : h) : (rand() > 0.5 ? 0 : w);
                const inner = horizontal
                    ? (outer === 0 ? rect.y : rect.y + rect.h)
                    : (outer === 0 ? rect.x : rect.x + rect.w);
                ctx.beginPath();
                if (horizontal) {
                    ctx.moveTo(start, outer);
                    ctx.lineTo(start, (outer + inner) / 2);
                    ctx.lineTo(end, (outer + inner) / 2);
                    ctx.lineTo(end, inner);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(end, inner, 2.5, 0, Math.PI * 2);
                    ctx.fillStyle = trace;
                    ctx.fill();
                } else {
                    ctx.moveTo(outer, start);
                    ctx.lineTo((outer + inner) / 2, start);
                    ctx.lineTo((outer + inner) / 2, end);
                    ctx.lineTo(inner, end);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(inner, end, 2.5, 0, Math.PI * 2);
                    ctx.fillStyle = trace;
                    ctx.fill();
                }
            }
            ctx.restore();
            break;
        }
        case "marble":
        case "wooden":
        case "frost": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            if (kind === "marble") {
                paintTexture(ctx, "marble", { x: 0, y: 0, w, h }, params, seed);
            } else if (kind === "wooden") {
                paintTexture(ctx, "wood", { x: 0, y: 0, w, h }, params, seed);
            } else {
                paintTexture(ctx, "frost", { x: 0, y: 0, w, h }, params, seed);
            }
            ctx.restore();
            if (kind === "frost" && bool(params, "sparkle", true)) {
                ctx.save();
                ringPath(ctx, rect, w, h);
                ctx.fillStyle = "rgba(255,255,255,0.85)";
                for (let i = 0; i < 70; i++) {
                    const x = rand() * w;
                    const y = rand() * h;
                    ctx.fillRect(x, y, 1.5, 1.5);
                }
                ctx.restore();
            }
            if (kind === "marble" && bool(params, "inner_bevel", true)) {
                ctx.strokeStyle = "rgba(0,0,0,0.35)";
                ctx.lineWidth = 2;
                ctx.strokeRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
                ctx.strokeStyle = "rgba(255,255,255,0.35)";
                ctx.strokeRect(rect.x - 5, rect.y - 5, rect.w + 10, rect.h + 10);
            }
            if (kind === "wooden") {
                ctx.strokeStyle = "rgba(0,0,0,0.35)";
                ctx.lineWidth = 2;
                ctx.strokeRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
            }
            break;
        }
        case "mosaic": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "grout_color", "#D2CDC3");
            ctx.fillRect(0, 0, w, h);
            const tile = Math.max(3, num(params, "tile_size", 14));
            const grout = Math.max(0, num(params, "grout_width", 2));
            const variety = clamp(num(params, "color_variety", 70), 0, 100);
            const sat = clamp(num(params, "saturation", 85), 0, 100);
            for (let y = 0; y < h; y += tile) {
                for (let x = 0; x < w; x += tile) {
                    const hue = rand() * 360;
                    const light = 35 + rand() * 45;
                    ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
                    ctx.globalAlpha = 0.75 + (variety / 100) * 0.25;
                    ctx.fillRect(x + grout / 2, y + grout / 2, tile - grout, tile - grout);
                    ctx.globalAlpha = 1;
                    if (rand() > 0.7) {
                        ctx.fillStyle = "rgba(255,255,255,0.18)";
                        ctx.fillRect(x + grout / 2, y + grout / 2, tile - grout, 1);
                    }
                }
            }
            ctx.restore();
            break;
        }
        case "rope": {
            const ropeColor = str(params, "rope_color", "#B4915A");
            paintWesternBand(ctx, rect, w, h, { top: true, right: true, bottom: true, left: true }, border / 2, str(params, "bg_color", "#3C2D1E"), ropeColor, false);
            ctx.save();
            ringPath(ctx, rect, w, h);
            const step = Math.max(4, num(params, "twist_density", 50) / 3);
            ctx.strokeStyle = ropeColor;
            ctx.lineWidth = Math.max(2, border / 8);
            ctx.beginPath();
            for (let x = 0; x <= w; x += 2) {
                const y = rect.y - border / 2 + Math.sin(x / step) * border * 0.28;
                if (x === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
            ctx.restore();
            break;
        }
        case "stained": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = "#161616";
            ctx.fillRect(0, 0, w, h);
            const panel = Math.max(8, num(params, "panel_width", 40));
            const lead = Math.max(1, num(params, "lead_thickness", 3.5));
            const bright = clamp(num(params, "glass_brightness", 75), 0, 100) / 100;
            for (let y = 0; y < h; y += panel) {
                for (let x = 0; x < w; x += panel) {
                    const jx = x + rand() * panel * 0.25;
                    const jy = y + rand() * panel * 0.25;
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(x + panel, jy);
                    ctx.lineTo(jx + panel, y + panel);
                    ctx.lineTo(jx, y + panel);
                    ctx.closePath();
                    ctx.fillStyle = `hsl(${rand() * 360}, 70%, ${25 + bright * 40}%)`;
                    ctx.fill();
                    ctx.strokeStyle = "#0B0B0B";
                    ctx.lineWidth = lead;
                    ctx.stroke();
                }
            }
            ctx.restore();
            break;
        }
        case "starfield": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "bg_color", "#050512");
            ctx.fillRect(0, 0, w, h);
            const nebula = str(params, "nebula_color", "#280A50");
            const g = ctx.createRadialGradient(w * 0.7, h * 0.3, 0, w * 0.7, h * 0.3, Math.max(w, h) * 0.7);
            g.addColorStop(0, nebula);
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g;
            ctx.globalAlpha = clamp(num(params, "nebula_intensity", 45) / 100, 0, 1);
            ctx.fillRect(0, 0, w, h);
            ctx.globalAlpha = 1;
            const stars = Math.round((clamp(num(params, "star_density", 65), 0, 100) / 100) * 220);
            for (let i = 0; i < stars; i++) {
                const x = rand() * w;
                const y = rand() * h;
                const size = rand() * 1.6 + 0.4;
                ctx.fillStyle = `rgba(255,255,255,${0.4 + rand() * 0.6})`;
                ctx.fillRect(x, y, size, size);
                if (bool(params, "bright_stars", true) && rand() > 0.94) {
                    ctx.fillRect(x - 2, y, 5, 0.6);
                    ctx.fillRect(x, y - 2, 0.6, 5);
                }
            }
            ctx.restore();
            break;
        }
        case "watercolor": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "wash_color", "#B9A082");
            ctx.globalAlpha = clamp(num(params, "opacity", 90) / 100, 0, 1);
            ctx.fillRect(0, 0, w, h);
            ctx.globalAlpha = 0.25;
            for (let i = 0; i < 80; i++) {
                const x = rand() * w;
                const y = rand() * h;
                const r = 4 + rand() * Math.max(6, border / 3);
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = rand() > 0.5 ? "#FFFFFF" : "#5A4A38";
                ctx.fill();
            }
            ctx.restore();
            break;
        }
        case "lava": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "rock_color", "#1E1916");
            ctx.fillRect(0, 0, w, h);
            const lava = str(params, "lava_color", "#FF500A");
            ctx.strokeStyle = lava;
            ctx.shadowColor = lava;
            ctx.shadowBlur = clamp(num(params, "glow_intensity", 70) / 2, 0, 40);
            const cracks = Math.round(clamp(num(params, "crack_density", 60), 0, 100) / 5);
            for (let i = 0; i < cracks; i++) {
                ctx.lineWidth = 1 + rand() * 2.5;
                ctx.beginPath();
                let x = rand() * w;
                let y = rand() * h;
                ctx.moveTo(x, y);
                for (let k = 0; k < 4; k++) {
                    x += (rand() - 0.5) * border;
                    y += (rand() - 0.5) * border;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            if (bool(params, "ember_sparks", true)) {
                ctx.shadowBlur = 0;
                for (let i = 0; i < 40; i++) {
                    ctx.fillStyle = `rgba(255,${120 + rand() * 100},0,${0.3 + rand() * 0.7})`;
                    ctx.fillRect(rand() * w, rand() * h, 2, 2);
                }
            }
            ctx.restore();
            break;
        }
        case "ornate": {
            fillRing(ctx, rect, str(params, "frame_color", "#F5F0DC"));
            ctx.strokeStyle = str(params, "ornament_color", "#A0823C");
            ctx.lineWidth = Math.max(1, num(params, "line_thickness", 2));
            ctx.strokeRect(rect.x - border * 0.2, rect.y - border * 0.2, rect.w + border * 0.4, rect.h + border * 0.4);
            ctx.strokeRect(rect.x - border * 0.75, rect.y - border * 0.75, rect.w + border * 1.5, rect.h + border * 1.5);
            const curl = border * 0.33;
            const corners = [
                [0, 0, 1, 1],
                [w, 0, -1, 1],
                [w, h, -1, -1],
                [0, h, 1, -1],
            ];
            for (const c of corners) {
                ctx.beginPath();
                ctx.moveTo(c[0], c[1] + c[3] * curl * 1.6);
                ctx.bezierCurveTo(c[0] + c[2] * curl, c[1] + c[3] * curl, c[0] + c[2] * curl * 2, c[1] + c[3] * curl * 0.2, c[0] + c[2] * curl * 1.6, c[1]);
                ctx.stroke();
            }
            break;
        }
        case "artdeco": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "bg_color", "#0F0F19");
            ctx.fillRect(0, 0, w, h);
            const accent = str(params, "accent_color", "#D4AF37");
            const rays = Math.round(clamp(num(params, "fan_rays", 7), 2, 24));
            const spacing = Math.max(6, num(params, "fan_spacing", 80) / 4);
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1.5;
            const corners = [
                [0, 0, 1, 1],
                [w, 0, -1, 1],
                [w, h, -1, -1],
                [0, h, 1, -1],
            ];
            for (const c of corners) {
                for (let i = 0; i < rays; i++) {
                    const a = (i / rays) * (Math.PI / 2);
                    ctx.beginPath();
                    ctx.moveTo(c[0], c[1]);
                    ctx.lineTo(c[0] + c[2] * Math.cos(a) * border * 1.8, c[1] + c[3] * Math.sin(a) * border * 1.8);
                    ctx.stroke();
                }
            }
            if (bool(params, "inner_lines", true)) {
                for (let d = spacing; d < border; d += spacing) {
                    ctx.strokeRect(rect.x - d, rect.y - d, rect.w + d * 2, rect.h + d * 2);
                }
            }
            ctx.restore();
            break;
        }
        case "chrome":
        case "golden": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            const tint = parseColor(kind === "chrome" ? str(params, "tint_color", "#C8CDD2") : str(params, "color", "#D4AF37"));
            const g = ctx.createLinearGradient(0, 0, w, h);
            const stops = [0.2, 0.65, 1.35, 2.05];
            stops.forEach((t, i) => {
                const lightFactor = i % 2 === 0 ? 1.25 : 0.55;
                const rr = clamp255(tint[0] * lightFactor);
                const gg = clamp255(tint[1] * lightFactor);
                const bb = clamp255(tint[2] * lightFactor);
                g.addColorStop(Math.min(1, t / 2.3), `rgb(${rr},${gg},${bb})`);
            });
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
            const line = Math.max(1, border / 12);
            ctx.strokeStyle = kind === "chrome" ? "rgba(255,255,255,0.75)" : "rgba(255,245,180,0.7)";
            ctx.lineWidth = line;
            ctx.strokeRect(rect.x - border * 0.15, rect.y - border * 0.15, rect.w + border * 0.3, rect.h + border * 0.3);
            if (kind === "golden" ? bool(params, "inner_border", true) : bool(params, "inner_line", true)) {
                ctx.strokeStyle = "rgba(0,0,0,0.35)";
                ctx.strokeRect(rect.x - border * 0.55, rect.y - border * 0.55, rect.w + border * 1.1, rect.h + border * 1.1);
            }
            break;
        }
        case "crimson": {
            fillRing(ctx, rect, str(params, "color", "#990012"));
            ctx.save();
            ctx.strokeStyle = "rgba(255,80,80,0.55)";
            ctx.shadowColor = "#FF3030";
            ctx.shadowBlur = clamp(num(params, "glow_strength", 50) / 2, 0, 30);
            ctx.lineWidth = 2;
            ctx.strokeRect(rect.x - border * 0.2, rect.y - border * 0.2, rect.w + border * 0.4, rect.h + border * 0.4);
            ctx.restore();
            if (bool(params, "outer_line", true)) {
                ctx.strokeStyle = "rgba(0,0,0,0.55)";
                ctx.lineWidth = 2;
                ctx.strokeRect(1, 1, w - 2, h - 2);
            }
            break;
        }
        case "filmstrip": {
            fillRing(ctx, rect, str(params, "frame_color", "#0F0F0F"));
            const hole = Math.max(3, (num(params, "hole_size", 55) / 100) * border * 0.4);
            const band = border;
            ctx.fillStyle = "#050505";
            for (let x = 6; x < w - hole; x += hole * 2.2) {
                if (rect.y > hole * 1.4) {
                    traceRoundRect(ctx, x, Math.max(2, rect.y - band + (band - hole) / 2), hole, hole * 0.62, hole * 0.14);
                    ctx.fill();
                }
                if (h - rect.y - rect.h > hole * 1.4) {
                    traceRoundRect(ctx, x, rect.y + rect.h + band - (band + hole) / 2, hole, hole * 0.62, hole * 0.14);
                    ctx.fill();
                }
            }
            if (bool(params, "side_strips", false)) {
                for (let y = 6; y < h - hole; y += hole * 2.2) {
                    traceRoundRect(ctx, Math.max(2, rect.x - band + (band - hole) / 2), y, hole * 0.62, hole, hole * 0.14);
                    ctx.fill();
                    traceRoundRect(ctx, rect.x + rect.w + band - (band + hole) / 2, y, hole * 0.62, hole, hole * 0.14);
                    ctx.fill();
                }
            }
            if (bool(params, "scratches", true)) {
                ctx.strokeStyle = "rgba(255,255,255,0.12)";
                for (let i = 0; i < 18; i++) {
                    const x = rand() * w;
                    ctx.beginPath();
                    ctx.moveTo(x, rect.y - band);
                    ctx.lineTo(x + (rand() - 0.5) * 6, rect.y);
                    ctx.stroke();
                }
            }
            break;
        }
        case "polaroid": {
            fillRing(ctx, rect, str(params, "frame_color", "#FAF9F5"));
            const caption = str(params, "caption", "");
            const bottom = num(params, "bottom_size", 80);
            if (caption) {
                ctx.fillStyle = "#222222";
                ctx.font = `${Math.max(10, bottom * 0.22)}px "Segoe UI", sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(caption, rect.x + rect.w / 2, rect.y + rect.h + bottom / 2);
            }
            ctx.strokeStyle = "rgba(0,0,0,0.06)";
            ctx.lineWidth = 1;
            ctx.strokeRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);
            break;
        }
        case "macos":
        case "windows11": {
            const dark = bool(params, "dark_mode", false);
            const panel = dark ? "#1E1E1E" : "#F3F3F3";
            const text = dark ? "#E8E8E8" : "#333333";
            const radius = Math.max(0, num(params, "corner_radius", 10));
            ctx.save();
            ctx.fillStyle = panel;
            traceRoundRect(ctx, 0, 0, w, h, radius);
            ctx.fill();
            ctx.restore();
            const titleH = Math.min(rect.y, kind === "macos" ? 30 : 34);
            if (titleH > 8) {
                ctx.save();
                traceRoundRect(ctx, 0, 0, w, h, radius);
                ctx.clip();
                ctx.fillStyle = dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)";
                ctx.fillRect(0, 0, w, rect.y);
                ctx.restore();
                if (kind === "macos") {
                    const colors = ["#FF5F57", "#FEBC2E", "#28C840"];
                    colors.forEach((color, i) => {
                        ctx.beginPath();
                        ctx.arc(12 + i * 16, titleH / 2 + 2, 5, 0, Math.PI * 2);
                        ctx.fillStyle = color;
                        ctx.fill();
                    });
                } else {
                    const cy = rect.y / 2;
                    ctx.strokeStyle = text;
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.moveTo(w - 78, cy - 4);
                    ctx.lineTo(w - 70, cy - 4);
                    ctx.stroke();
                    ctx.strokeRect(w - 48, cy - 7, 9, 9);
                    ctx.beginPath();
                    ctx.moveTo(w - 22, cy - 6);
                    ctx.lineTo(w - 13, cy + 3);
                    ctx.moveTo(w - 13, cy - 6);
                    ctx.lineTo(w - 22, cy + 3);
                    ctx.stroke();
                }
                const title = str(params, "title", "");
                if (title) {
                    ctx.fillStyle = text;
                    ctx.font = `${Math.max(10, titleH * 0.4)}px "Segoe UI", sans-serif`;
                    ctx.textAlign = "left";
                    ctx.textBaseline = "middle";
                    ctx.fillText(title, kind === "macos" ? 62 : 14, titleH / 2 + 1);
                }
            }
            break;
        }
        case "torn": {
            const paper = str(params, "frame_color", "#E8E2D4");
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = paper;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
            const rough = clamp(
                num(params, "torn_depth", num(params, "roughness", 6)),
                1,
                Math.max(2, border * 0.6)
            );
            const step = Math.max(2, rough);
            ctx.save();
            ctx.fillStyle = paper;
            ctx.beginPath();
            for (let x = rect.x; x < rect.x + rect.w; x += step) {
                const amp = rough * (0.3 + 0.7 * valueNoise2D(x / step, 3.7, seed));
                ctx.moveTo(x, rect.y);
                ctx.lineTo(x + step + 1, rect.y);
                ctx.lineTo(x + step * 0.5, rect.y + amp);
                ctx.closePath();
            }
            for (let x = rect.x; x < rect.x + rect.w; x += step) {
                const amp = rough * (0.3 + 0.7 * valueNoise2D(x / step, 11.3, seed));
                ctx.moveTo(x, rect.y + rect.h);
                ctx.lineTo(x + step + 1, rect.y + rect.h);
                ctx.lineTo(x + step * 0.5, rect.y + rect.h - amp);
                ctx.closePath();
            }
            for (let y = rect.y; y < rect.y + rect.h; y += step) {
                const amp = rough * (0.3 + 0.7 * valueNoise2D(y / step, 23.9, seed));
                ctx.moveTo(rect.x, y);
                ctx.lineTo(rect.x, y + step + 1);
                ctx.lineTo(rect.x + amp, y + step * 0.5);
                ctx.closePath();
            }
            for (let y = rect.y; y < rect.y + rect.h; y += step) {
                const amp = rough * (0.3 + 0.7 * valueNoise2D(y / step, 37.1, seed));
                ctx.moveTo(rect.x + rect.w, y);
                ctx.lineTo(rect.x + rect.w, y + step + 1);
                ctx.lineTo(rect.x + rect.w - amp, y + step * 0.5);
                ctx.closePath();
            }
            ctx.fill();
            ctx.restore();
            break;
        }
        case "cartoon": {
            fillRing(ctx, rect, str(params, "color", "#FFFFFF"));
            ctx.strokeStyle = "#111111";
            ctx.lineWidth = Math.max(2, border / 8);
            ctx.strokeRect(2, 2, w - 4, h - 4);
            ctx.strokeRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
            break;
        }
        case "stencil": {
            ctx.save();
            ringPath(ctx, rect, w, h);
            ctx.fillStyle = str(params, "stencil_color", "#000000DC");
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = "rgba(255,255,255,0.05)";
            for (let i = 0; i < 180; i++) {
                ctx.fillRect(rand() * w, rand() * h, 1.5, 1.5);
            }
            ctx.restore();
            break;
        }
        default:
            break;
    }
    ctx.restore();
}

export interface EdgeSides {
    top?: boolean;
    right?: boolean;
    bottom?: boolean;
    left?: boolean;
    curved?: boolean;
}

function edgeBoundary(
    t: number,
    depth: number,
    range: number,
    seed: number,
    kind: "torn" | "wave",
    curved: boolean
): number {
    if (kind === "wave") {
        const wavelength = Math.max(8, range * 2);
        return depth + Math.sin((t / wavelength) * Math.PI * 2) * range;
    }
    const scale = curved ? 55 : 17;
    const n = valueNoise2D(t / scale + 0.5, 0.5, seed);
    return depth + (n - 0.5) * 2 * range;
}

function applyEdgeMask(
    src: ImageData,
    depth: number,
    range: number,
    sides: EdgeSides,
    seed: number,
    kind: "torn" | "wave"
): ImageData {
    const d = clamp(depth, 0, 200);
    const amp = clamp(range, 0, 200);
    const top = sides.top !== false;
    const right = sides.right !== false;
    const bottom = sides.bottom !== false;
    const left = sides.left !== false;
    const curved = sides.curved === true;
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const s = src.data;
    const o = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            o[i] = s[i];
            o[i + 1] = s[i + 1];
            o[i + 2] = s[i + 2];
            o[i + 3] = s[i + 3];
            if (s[i + 3] === 0) {
                continue;
            }
            let alpha = 1;
            if (top) {
                const b = edgeBoundary(x, d, amp, seed + 1, kind, curved);
                alpha = Math.min(alpha, clamp(y - b + 0.5, 0, 1));
            }
            if (bottom) {
                const b = edgeBoundary(x, d, amp, seed + 2, kind, curved);
                alpha = Math.min(alpha, clamp(h - 1 - y - b + 0.5, 0, 1));
            }
            if (left) {
                const b = edgeBoundary(y, d, amp, seed + 3, kind, curved);
                alpha = Math.min(alpha, clamp(x - b + 0.5, 0, 1));
            }
            if (right) {
                const b = edgeBoundary(y, d, amp, seed + 4, kind, curved);
                alpha = Math.min(alpha, clamp(w - 1 - x - b + 0.5, 0, 1));
            }
            if (alpha < 1) {
                o[i + 3] = s[i + 3] * alpha;
            }
        }
    }
    return out;
}

/** Ragged alpha edge, no padding change. */
export function tornEdge(
    src: ImageData,
    depth: number,
    range: number,
    sides: EdgeSides = {},
    seed = 1
): ImageData {
    return applyEdgeMask(src, depth, range, sides, seed, "torn");
}

/** Sine-wave alpha edge, no padding change. */
export function waveEdge(
    src: ImageData,
    depth: number,
    range: number,
    sides: EdgeSides = {},
    seed = 1
): ImageData {
    return applyEdgeMask(src, depth, range, sides, seed, "wave");
}
