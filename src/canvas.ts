/**
 * Scene layout + rendering + compositing shared by the screen view and export.
 *
 * Annotations are authored in original image pixel space. `computeScene` maps
 * that space into output pixels (margin / padding / ratio / rotation); both the
 * interactive canvas and the PNG exporter call `renderScene`, so what is on
 * screen always matches the exported file.
 *
 * This module is pure rendering: it never registers listeners or touches state.
 */
import { DEFAULT_BG } from "./types.ts";
import type {
    Annotation,
    BgState,
    Decoration,
    EffectState,
} from "./types.ts";
import { NO_INSETS } from "./effects/types.ts";
import type { Insets } from "./effects/types.ts";

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Scene {
    imgW: number;
    imgH: number;
    margin: number;
    padding: number;
    outW: number;
    outH: number;
    /** content rect (original image area) */
    img: Rect;
    /** processed image rect (content + effect frame padding) */
    proc: Rect;
    /** processed canvas size before rotation */
    procW: number;
    procH: number;
    frame: Rect;
    rotate: number;
    /** background state (written by computeScene for renderScene) */
    bg?: BgState;
}

export interface RenderOptions {
    image: CanvasImageSource | null;
    bgImage?: CanvasImageSource | null;
    annotations: Annotation[];
    effects: EffectState;
    images?: Map<string, CanvasImageSource>;
    selectedId?: string | null;
    showSelection?: boolean;
    handleScale?: number;
}

export interface ScreenFit {
    cssW: number;
    cssH: number;
    pixelRatio: number;
    screenScale: number;
}

/** Upper bound (in device pixels) for either side of the screen canvas backing store. */
const MAX_BACKING_SIDE = 4096;

const DEFAULT_STROKE = "#F03E3E";
const DEFAULT_WIDTH = 4;
const SELECTION_COLOR = "#3E83F2";
const DECOR_COLORS = [
    "#F03E3E", "#F59F00", "#2F9E44", "#1098AD",
    "#1971C2", "#7048E8", "#FFD60A", "#E93D82",
];

let measureCtx: CanvasRenderingContext2D | null = null;

/* ------------------------------------------------------------- helpers */

function clamp(value: number, lo: number, hi: number): number {
    if (!Number.isFinite(value)) {
        return lo;
    }
    return Math.min(hi, Math.max(lo, value));
}

function normalizeRotate(rotate: number): number {
    if (!Number.isFinite(rotate)) {
        return 0;
    }
    const snapped = Math.round(rotate / 90) * 90;
    return ((snapped % 360) + 360) % 360;
}

/** 解析 "16:9" 这类比例；Auto/Custom 或非法值返回 null。 */
function ratioValue(ratio: string | undefined): number | null {
    if (!ratio) {
        return null;
    }
    const key = ratio.trim();
    if (key === "Auto" || key === "Custom") {
        return null;
    }
    const parts = key.split(":");
    if (parts.length !== 2) {
        return null;
    }
    const rw = Number(parts[0]);
    const rh = Number(parts[1]);
    if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) {
        return null;
    }
    return rw / rh;
}

function getMeasureCtx(): CanvasRenderingContext2D {
    if (!measureCtx) {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("2d context unavailable");
        }
        measureCtx = ctx;
    }
    return measureCtx;
}

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
    if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) {
        return {
            w: Math.max(1, src.naturalWidth || src.width || 1),
            h: Math.max(1, src.naturalHeight || src.height || 1),
        };
    }
    if (typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement) {
        return { w: Math.max(1, src.width), h: Math.max(1, src.height) };
    }
    if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
        return {
            w: Math.max(1, src.videoWidth || src.width),
            h: Math.max(1, src.videoHeight || src.height),
        };
    }
    if (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap) {
        return { w: Math.max(1, src.width), h: Math.max(1, src.height) };
    }
    const fallback = src as unknown as { width?: number; height?: number };
    return {
        w: Math.max(1, fallback.width ?? 1),
        h: Math.max(1, fallback.height ?? 1),
    };
}

function pathRoundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number
): void {
    const width = Math.max(1, w);
    const height = Math.max(1, h);
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
}

function mulberry32(seed: number): () => number {
    let t = (Math.floor(seed) || 0) >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

function colorWithAlpha(color: string, alpha: number): string {
    const a = clamp(alpha, 0, 1);
    const value = color || "#000000";
    if (value.charAt(0) !== "#") {
        return value;
    }
    let hex = value.slice(1);
    if (hex.length === 3) {
        hex = hex.split("").map((ch) => ch + ch).join("");
    }
    if (hex.length < 6) {
        return value;
    }
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${a})`;
}

/* --------------------------------------------------------------- scene */

export function computeScene(
    imgW: number,
    imgH: number,
    bg: BgState,
    rotate = 0,
    pad: Insets = NO_INSETS
): Scene {
    const iw = Math.max(1, Math.round(imgW));
    const ih = Math.max(1, Math.round(imgH));
    const bgPad = Math.round(clamp(bg.padding, 0, 200));
    const margin = Math.round(clamp(bg.margin, 0, 200));
    const rot = normalizeRotate(rotate);
    const swapped = rot % 180 !== 0;
    const rw = swapped ? ih : iw;
    const rh = swapped ? iw : ih;

    // Frame effects expand the processed canvas; pads are in image-space pixels.
    const pl = Math.max(0, Math.round(pad.left));
    const pr = Math.max(0, Math.round(pad.right));
    const pt = Math.max(0, Math.round(pad.top));
    const pb = Math.max(0, Math.round(pad.bottom));
    const procW = iw + pl + pr;
    const procH = ih + pt + pb;
    const rwProc = swapped ? procH : procW;
    const rhProc = swapped ? procW : procH;

    let outW = rwProc + bgPad * 2 + margin * 2;
    let outH = rhProc + bgPad * 2 + margin * 2;

    const target = ratioValue(bg.ratio);
    if (target !== null) {
        if (outW / outH < target) {
            outW = outH * target;
        } else {
            outH = outW / target;
        }
    }

    const width = Math.max(1, Math.round(outW));
    const height = Math.max(1, Math.round(outH));

    const proc: Rect = {
        x: Math.round((width - rwProc) / 2),
        y: Math.round((height - rhProc) / 2),
        w: Math.round(rwProc),
        h: Math.round(rhProc),
    };
    const img: Rect = {
        x: Math.round(proc.x + (rwProc - rw) / 2),
        y: Math.round(proc.y + (rhProc - rh) / 2),
        w: Math.round(rw),
        h: Math.round(rh),
    };
    const frame: Rect = {
        x: Math.round(img.x - bgPad),
        y: Math.round(img.y - bgPad),
        w: Math.round(img.w + bgPad * 2),
        h: Math.round(img.h + bgPad * 2),
    };

    return {
        imgW: iw,
        imgH: ih,
        margin,
        padding: bgPad,
        outW: width,
        outH: height,
        img,
        proc,
        procW,
        procH,
        frame,
        rotate: rot,
        bg,
    };
}

function sceneCorner(scene: Scene): number {
    const bg = scene.bg ?? DEFAULT_BG;
    const corner = Number.isFinite(bg.corner) ? bg.corner : 8;
    return Math.max(0, Math.min(corner, Math.min(scene.outW, scene.outH) / 2));
}

/** Checkerboard palette / cell size, identical to the `draw_checkerboard` effect. */
const CHECKER_COLORS = ["#D3D3D3", "#FFFFFF"];
const CHECKER_CELL = 10;

/**
 * Builds a repeating checkerboard pattern from a 2×cell offscreen tile.
 * Falls back to the light colour when no canvas/pattern is available.
 */
function checkerFill(ctx: CanvasRenderingContext2D): string | CanvasPattern {
    if (typeof document === "undefined") {
        return CHECKER_COLORS[1];
    }
    const tile = document.createElement("canvas");
    const size = CHECKER_CELL * 2;
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext("2d");
    if (!tileCtx) {
        return CHECKER_COLORS[1];
    }
    for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
            tileCtx.fillStyle =
                (row + col) % 2 === 0 ? CHECKER_COLORS[0] : CHECKER_COLORS[1];
            tileCtx.fillRect(
                col * CHECKER_CELL,
                row * CHECKER_CELL,
                CHECKER_CELL,
                CHECKER_CELL
            );
        }
    }
    return ctx.createPattern(tile, "repeat") ?? CHECKER_COLORS[1];
}

function backgroundStyle(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    bg: BgState
): string | CanvasGradient {
    if (bg.mode === "checker") {
        return CHECKER_COLORS[1];
    }
    if (bg.mode === "gradient") {
        const gradient = ctx.createLinearGradient(
            scene.frame.x,
            scene.frame.y,
            scene.frame.x + scene.frame.w,
            scene.frame.y + scene.frame.h
        );
        gradient.addColorStop(0, bg.gradientFrom || "#8B5CF6");
        gradient.addColorStop(1, bg.gradientTo || "#22D3EE");
        return gradient;
    }
    return bg.solid || "#3E83F2";
}

/** 背景图按 cover 铺满指定矩形。 */
function drawCover(
    ctx: CanvasRenderingContext2D,
    src: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number
): void {
    const size = sourceSize(src);
    const scale = Math.max(w / size.w, h / size.h);
    const dw = size.w * scale;
    const dh = size.h * scale;
    ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 阴影层与背景使用同一种填充，避免内边距区域出现色差。 */
function shadowFillStyle(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    bg: BgState,
    bgImage: CanvasImageSource | null | undefined,
    checker: string | CanvasPattern | null
): string | CanvasGradient | CanvasPattern {
    if (checker) {
        return checker;
    }
    if (bg.mode === "image" && bgImage && typeof DOMMatrix !== "undefined") {
        const size = sourceSize(bgImage);
        const scale = Math.max(scene.outW / size.w, scene.outH / size.h);
        const pattern = ctx.createPattern(bgImage, "no-repeat");
        if (pattern) {
            pattern.setTransform(
                new DOMMatrix()
                    .translate(
                        (scene.outW - size.w * scale) / 2,
                        (scene.outH - size.h * scale) / 2
                    )
                    .scale(scale, scale)
            );
            return pattern;
        }
    }
    return backgroundStyle(ctx, scene, bg);
}

/* ------------------------------------------------------------ selection */

function drawSelection(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    handleScale: number
): void {
    const b = annotationBounds(a, ctx);
    const scale = Math.max(0.0001, handleScale || 1);
    const pad = 4;
    const x = b.x - pad;
    const y = b.y - pad;
    const w = Math.max(8, b.w + pad * 2);
    const h = Math.max(8, b.h + pad * 2);

    ctx.save();
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    const handle = 5 / scale;
    ctx.fillStyle = SELECTION_COLOR;
    const corners: Array<[number, number]> = [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
    ];
    for (const [hx, hy] of corners) {
        ctx.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }
    ctx.restore();
}

/* ------------------------------------------------------ annotation paint */

function dashFor(a: Annotation): number[] {
    const width = Math.max(0.1, a.width ?? DEFAULT_WIDTH);
    const k = Math.max(1, width / 4);
    switch (a.borderStyle) {
        case "dash":
            return [7 * k, 5 * k];
        case "dot":
            return [1 * k, 5 * k];
        case "dashdot":
            return [9 * k, 3 * k, 1 * k, 3 * k];
        default:
            return [];
    }
}

function fillOf(a: Annotation): string | null {
    const fill = a.fill;
    if (!fill || fill === "transparent" || fill === "none") {
        return null;
    }
    return fill;
}

function applyShadow(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const shadow = a.shadow;
    if (!shadow || !shadow.enabled) {
        return;
    }
    ctx.shadowColor = colorWithAlpha(shadow.color || "#000000", shadow.opacity ?? 0.5);
    ctx.shadowBlur = Math.max(0, shadow.blur ?? 0);
    ctx.shadowOffsetX = shadow.x ?? 0;
    ctx.shadowOffsetY = shadow.y ?? 0;
}

function isShadowed(a: Annotation): boolean {
    switch (a.type) {
        case "rectangle":
        case "ellipse":
        case "line":
        case "arrow":
        case "freehand":
        case "text":
        case "speech":
        case "step":
        case "image":
        case "emoji":
        case "cursor":
            return true;
        default:
            return false;
    }
}

function fontOf(a: Annotation): string {
    const size = Math.max(6, a.fontSize ?? 24);
    const italic = a.italic ? "italic " : "";
    const weight = a.bold === false ? "400 " : "700 ";
    const family = a.fontFamily || "Segoe UI";
    return `${italic}${weight}${size}px ${family}, "Segoe UI", system-ui`;
}

function lineHeightOf(a: Annotation): number {
    return Math.max(6, a.fontSize ?? 24) * 1.25;
}

function textLines(a: Annotation): string[] {
    return (a.text ?? "").split("\n");
}

function measureTextWidth(
    ctx: CanvasRenderingContext2D | undefined,
    a: Annotation
): number {
    const target = ctx ?? getMeasureCtx();
    const previous = target.font;
    target.font = fontOf(a);
    let max = 0;
    for (const line of textLines(a)) {
        max = Math.max(max, target.measureText(line).width);
    }
    target.font = previous;
    return max;
}

function setupAnno(ctx: CanvasRenderingContext2D, a: Annotation): void {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(0.1, a.width ?? DEFAULT_WIDTH);
    ctx.strokeStyle = a.stroke || DEFAULT_STROKE;
    ctx.setLineDash(dashFor(a));
}

function drawRectangle(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    const radius = Math.min(a.corner ?? 0, Math.min(b.w, b.h) / 2);
    pathRoundRect(ctx, b.x, b.y, Math.max(b.w, 1), Math.max(b.h, 1), radius);
    const fill = fillOf(a);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.stroke();
}

function drawEllipse(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    ctx.beginPath();
    ctx.ellipse(
        b.x + b.w / 2,
        b.y + b.h / 2,
        Math.max(b.w / 2, 0.5),
        Math.max(b.h / 2, 0.5),
        0,
        0,
        Math.PI * 2
    );
    const fill = fillOf(a);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.stroke();
}

function drawLine(ctx: CanvasRenderingContext2D, a: Annotation): void {
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
}

const ARROW_HEAD_HALF = (26 * Math.PI) / 180;

interface ArrowHeadGeometry {
    trim: number;
    leftX: number;
    leftY: number;
    rightX: number;
    rightY: number;
}

function arrowHeadGeometry(a: Annotation): ArrowHeadGeometry {
    const dx = a.x2 - a.x1;
    const dy = a.y2 - a.y1;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const len = Math.max(10, (a.width ?? DEFAULT_WIDTH) * 3.4);
    return {
        trim: Math.min(dist, len * Math.cos(ARROW_HEAD_HALF)),
        leftX: a.x2 - len * Math.cos(angle - ARROW_HEAD_HALF),
        leftY: a.y2 - len * Math.sin(angle - ARROW_HEAD_HALF),
        rightX: a.x2 - len * Math.cos(angle + ARROW_HEAD_HALF),
        rightY: a.y2 - len * Math.sin(angle + ARROW_HEAD_HALF),
    };
}

function drawArrowHead(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const geo = arrowHeadGeometry(a);
    ctx.beginPath();
    ctx.moveTo(a.x2, a.y2);
    ctx.lineTo(geo.leftX, geo.leftY);
    ctx.lineTo(geo.rightX, geo.rightY);
    ctx.closePath();
    ctx.fillStyle = a.stroke || DEFAULT_STROKE;
    ctx.fill();
}

export function drawArrow(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const dx = a.x2 - a.x1;
    const dy = a.y2 - a.y1;
    const dist = Math.hypot(dx, dy);
    const geo = arrowHeadGeometry(a);
    const ux = dist > 0 ? dx / dist : 0;
    const uy = dist > 0 ? dy / dist : 0;
    ctx.save?.();
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2 - ux * geo.trim, a.y2 - uy * geo.trim);
    ctx.stroke();
    ctx.restore?.();
    drawArrowHead(ctx, a);
}

function drawFreehand(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const points = a.points ?? [];
    if (points.length < 2) {
        return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.stroke();
}

function drawTextBlock(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    x: number,
    y: number,
    width: number
): void {
    ctx.font = fontOf(a);
    ctx.textBaseline = "top";
    ctx.fillStyle = a.textColor || a.stroke || DEFAULT_STROKE;
    const align = a.align ?? "left";
    ctx.textAlign = align;
    const anchorX =
        align === "center" ? x + width / 2 : align === "right" ? x + width : x;
    const lines = textLines(a);
    const lineHeight = lineHeightOf(a);
    for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], anchorX, y + i * lineHeight);
    }
}

function drawText(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a, ctx);
    const width = b.w > 0 ? b.w : measureTextWidth(ctx, a);
    drawTextBlock(ctx, a, b.x, b.y, width);
}

function drawSpeech(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a, ctx);
    const w = Math.max(b.w, 1);
    const h = Math.max(b.h, 1);
    const radius = Math.min(a.corner ?? 0, Math.min(w, h) / 2);
    const fill = fillOf(a);

    pathRoundRect(ctx, b.x, b.y, w, h, radius);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.stroke();

    if (a.tail !== false) {
        const baseX = b.x + w * 0.32;
        const baseW = Math.max(10, Math.min(22, w * 0.25));
        const tailH = Math.max(8, Math.min(20, h * 0.25));
        ctx.beginPath();
        ctx.moveTo(baseX, b.y + h);
        ctx.lineTo(baseX + baseW, b.y + h);
        ctx.lineTo(baseX, b.y + h + tailH);
        ctx.closePath();
        if (fill) {
            ctx.fillStyle = fill;
            ctx.fill();
        }
        ctx.stroke();
    }

    if (a.text) {
        const pad = 6;
        drawTextBlock(ctx, a, b.x + pad, b.y + pad, Math.max(1, w - pad * 2));
    }
}

function lettersLabel(value: number): string {
    let n = Math.max(1, value);
    let out = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

function romanLabel(value: number): string {
    const table: Array<[number, string]> = [
        [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
        [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
        [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
    ];
    let n = Math.max(1, Math.min(3999, Math.round(value)));
    let out = "";
    for (const [amount, symbol] of table) {
        while (n >= amount) {
            out += symbol;
            n -= amount;
        }
    }
    return out;
}

function stepLabel(a: Annotation): string {
    const value = Math.max(1, Math.round(a.stepValue ?? 1));
    switch (a.stepType) {
        case "letters":
            return lettersLabel(value);
        case "roman":
            return romanLabel(value);
        default:
            return String(value);
    }
}

function drawStep(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    const radius = Math.max(0.5, Math.min(b.w, b.h) / 2);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = fillOf(a) ?? (a.stroke || DEFAULT_STROKE);
    ctx.fill();
    ctx.stroke();

    const label = stepLabel(a);
    if (label) {
        const size = Math.max(6, radius * 1.05);
        const family = a.fontFamily || "Segoe UI";
        ctx.font = `700 ${size}px ${family}, "Segoe UI", system-ui`;
        ctx.fillStyle = a.textColor || "#FFFFFF";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, cx, cy);
    }
}

function drawImageAnno(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    opts: RenderOptions
): void {
    const src = opts.images?.get(a.id);
    if (!src) {
        return;
    }
    const size = sourceSize(src);
    const b = annotationBounds(a);
    const scale = Math.min(b.w / size.w, b.h / size.h);
    if (!Number.isFinite(scale) || scale <= 0) {
        return;
    }
    const dw = size.w * scale;
    const dh = size.h * scale;
    ctx.drawImage(
        src,
        b.x + (b.w - dw) / 2,
        b.y + (b.h - dh) / 2,
        dw,
        dh
    );
}

function drawEmoji(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    const size = Math.max(1, Math.min(b.w, b.h) * 0.9);
    ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = a.textColor || "#000000";
    ctx.fillText(a.emoji || "😀", b.x + b.w / 2, b.y + b.h / 2);
}

function drawArrowCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    unit: number
): void {
    const points: Array<[number, number]> = [
        [0, 0], [0, 26], [7, 19], [12, 30], [18, 27], [13, 17], [22, 17],
    ];
    ctx.beginPath();
    points.forEach(([px, py], index) => {
        const dx = x + px * unit;
        const dy = y + py * unit;
        if (index === 0) {
            ctx.moveTo(dx, dy);
        } else {
            ctx.lineTo(dx, dy);
        }
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

function drawHandCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    unit: number
): void {
    ctx.beginPath();
    ctx.roundRect(x + 6 * unit, y + 9 * unit, 13 * unit, 13 * unit, 3 * unit);
    ctx.roundRect(x + 8 * unit, y + 2 * unit, 3.4 * unit, 10 * unit, 1.7 * unit);
    ctx.roundRect(x + 12.5 * unit, y, 3.4 * unit, 12 * unit, 1.7 * unit);
    ctx.roundRect(x + 17 * unit, y + 3 * unit, 3.4 * unit, 9 * unit, 1.7 * unit);
    ctx.fill();
    ctx.stroke();
}

function drawIbeamCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    unit: number
): void {
    ctx.beginPath();
    ctx.rect(x + 7 * unit, y + 3 * unit, 8 * unit, 2 * unit);
    ctx.rect(x + 9.5 * unit, y + 5 * unit, 3 * unit, 16 * unit);
    ctx.rect(x + 7 * unit, y + 21 * unit, 8 * unit, 2 * unit);
    ctx.fill();
    ctx.stroke();
}

function drawCrossCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    unit: number
): void {
    ctx.beginPath();
    ctx.rect(x + 9.5 * unit, y + 2 * unit, 3 * unit, 18 * unit);
    ctx.rect(x + 2 * unit, y + 9.5 * unit, 18 * unit, 3 * unit);
    ctx.fill();
    ctx.stroke();
}

function drawCursor(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    const size = Math.max(16, Math.min(200, Math.max(b.w, b.h)));
    const unit = size / 30;

    ctx.save();
    ctx.lineWidth = Math.max(1, unit * 1.6);
    ctx.strokeStyle = "#FFFFFF";
    ctx.fillStyle = a.stroke || DEFAULT_STROKE;
    ctx.setLineDash([]);
    switch (a.cursorType ?? "arrow") {
        case "hand":
            drawHandCursor(ctx, b.x, b.y, unit);
            break;
        case "ibeam":
            drawIbeamCursor(ctx, b.x, b.y, unit);
            break;
        case "cross":
            drawCrossCursor(ctx, b.x, b.y, unit);
            break;
        default:
            drawArrowCursor(ctx, b.x, b.y, unit);
            break;
    }
    ctx.restore();
}

function drawHighlight(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.fillStyle = fillOf(a) ?? "rgba(255,214,10,.45)";
    ctx.fillRect(b.x, b.y, Math.max(b.w, 1), Math.max(b.h, 1));
    ctx.restore();
}

function drawClone(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    opts: RenderOptions,
    imageFilter: string
): void {
    if (!opts.image) {
        return;
    }
    const b = annotationBounds(a);
    const w = Math.max(1, b.w);
    const h = Math.max(1, b.h);
    const sx = a.srcX ?? b.x;
    const sy = a.srcY ?? b.y;

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, w, h);
    ctx.clip();
    ctx.filter = imageFilter;
    ctx.drawImage(opts.image, sx, sy, w, h, b.x, b.y, w, h);
    ctx.filter = "none";
    ctx.restore();
}

function drawBlur(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    scene: Scene,
    opts: RenderOptions,
    imageFilter: string
): void {
    if (!opts.image) {
        return;
    }
    const b = annotationBounds(a);
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, Math.max(b.w, 1), Math.max(b.h, 1));
    ctx.clip();
    ctx.filter = imageFilter === "none" ? "blur(8px)" : `${imageFilter} blur(8px)`;
    ctx.drawImage(opts.image, 0, 0, scene.imgW, scene.imgH);
    ctx.filter = "none";
    ctx.restore();
}

function drawPixelate(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    opts: RenderOptions,
    imageFilter: string
): void {
    if (!opts.image) {
        return;
    }
    const b = annotationBounds(a);
    const bw = Math.max(1, Math.round(b.w));
    const bh = Math.max(1, Math.round(b.h));
    const sw = Math.max(1, Math.round(bw / 12));
    const sh = Math.max(1, Math.round(bh / 12));

    const offscreen = document.createElement("canvas");
    offscreen.width = sw;
    offscreen.height = sh;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) {
        return;
    }
    offCtx.filter = imageFilter;
    offCtx.drawImage(opts.image, b.x, b.y, bw, bh, 0, 0, sw, sh);
    offCtx.filter = "none";

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, bw, bh);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreen, b.x, b.y, bw, bh);
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
}

function drawMagnify(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    scene: Scene,
    opts: RenderOptions,
    imageFilter: string
): void {
    if (!opts.image) {
        return;
    }
    const b = annotationBounds(a);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const factor = Math.max(1, (a.strength ?? 60) / 60);

    ctx.save();
    ctx.beginPath();
    if (a.effectEllipse) {
        ctx.ellipse(
            cx,
            cy,
            Math.max(b.w / 2, 0.5),
            Math.max(b.h / 2, 0.5),
            0,
            0,
            Math.PI * 2
        );
    } else {
        ctx.rect(b.x, b.y, Math.max(b.w, 1), Math.max(b.h, 1));
    }
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(factor, factor);
    ctx.translate(-cx, -cy);
    ctx.filter = imageFilter;
    ctx.drawImage(opts.image, 0, 0, scene.imgW, scene.imgH);
    ctx.filter = "none";
    ctx.restore();
}

function drawSpotlight(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    scene: Scene
): void {
    const b = annotationBounds(a);
    const blur = Math.max(0, a.spotlightBlur ?? 0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, scene.imgW, scene.imgH);
    ctx.clip();

    ctx.beginPath();
    ctx.rect(0, 0, scene.imgW, scene.imgH);
    if (a.effectEllipse) {
        ctx.ellipse(
            b.x + b.w / 2,
            b.y + b.h / 2,
            Math.max(b.w / 2, 0.5),
            Math.max(b.h / 2, 0.5),
            0,
            0,
            Math.PI * 2
        );
    } else {
        ctx.rect(b.x, b.y, Math.max(b.w, 1), Math.max(b.h, 1));
    }
    ctx.filter = blur > 0 ? `blur(${blur / 2}px)` : "none";
    ctx.fillStyle = "rgba(0,0,0,.62)";
    ctx.fill("evenodd");
    ctx.filter = "none";
    ctx.restore();
}

function drawCutout(ctx: CanvasRenderingContext2D, a: Annotation): void {
    const b = annotationBounds(a);
    const radius = Math.min(a.corner ?? 0, Math.min(b.w, b.h) / 2);
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    pathRoundRect(ctx, b.x, b.y, Math.max(b.w, 1), Math.max(b.h, 1), radius);
    ctx.fillStyle = "#000000";
    ctx.fill();
    ctx.restore();
}

function drawAnnotation(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    scene: Scene,
    opts: RenderOptions,
    imageFilter: string
): void {
    ctx.save();
    setupAnno(ctx, a);
    if (isShadowed(a)) {
        applyShadow(ctx, a);
    }

    switch (a.type) {
        case "rectangle":
            drawRectangle(ctx, a);
            break;
        case "ellipse":
            drawEllipse(ctx, a);
            break;
        case "line":
            drawLine(ctx, a);
            break;
        case "arrow":
            drawArrow(ctx, a);
            break;
        case "freehand":
            drawFreehand(ctx, a);
            break;
        case "text":
            drawText(ctx, a);
            break;
        case "speech":
            drawSpeech(ctx, a);
            break;
        case "step":
            drawStep(ctx, a);
            break;
        case "image":
            drawImageAnno(ctx, a, opts);
            break;
        case "clone":
            drawClone(ctx, a, opts, imageFilter);
            break;
        case "emoji":
            drawEmoji(ctx, a);
            break;
        case "cursor":
            drawCursor(ctx, a);
            break;
        case "highlight":
            drawHighlight(ctx, a);
            break;
        case "eraser":
            break;
        case "blur":
            drawBlur(ctx, a, scene, opts, imageFilter);
            break;
        case "pixelate":
            drawPixelate(ctx, a, opts, imageFilter);
            break;
        case "magnify":
            drawMagnify(ctx, a, scene, opts, imageFilter);
            break;
        case "spotlight":
            drawSpotlight(ctx, a, scene);
            break;
        case "cutout":
            drawCutout(ctx, a);
            break;
        default:
            break;
    }

    ctx.restore();
}

/* ---------------------------------------------------------- decorations */

function drawSnow(
    ctx: CanvasRenderingContext2D,
    rand: () => number,
    w: number,
    h: number
): void {
    ctx.fillStyle = "#FFFFFF";
    ctx.setLineDash([]);
    for (let i = 0; i < 60; i += 1) {
        ctx.globalAlpha = 0.35 + rand() * 0.55;
        ctx.beginPath();
        ctx.arc(rand() * w, rand() * h, 1 + rand() * 2.6, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function drawConfetti(
    ctx: CanvasRenderingContext2D,
    rand: () => number,
    w: number,
    h: number
): void {
    for (let i = 0; i < 48; i += 1) {
        ctx.save();
        ctx.translate(rand() * w, rand() * h);
        ctx.rotate(rand() * Math.PI * 2);
        ctx.globalAlpha = 0.65 + rand() * 0.3;
        ctx.fillStyle = DECOR_COLORS[i % DECOR_COLORS.length];
        ctx.fillRect(-4, -7, 8, 14);
        ctx.restore();
    }
    ctx.globalAlpha = 1;
}

function drawSparkle(
    ctx: CanvasRenderingContext2D,
    rand: () => number,
    w: number,
    h: number
): void {
    ctx.strokeStyle = "#FFFFFF";
    ctx.setLineDash([]);
    for (let i = 0; i < 36; i += 1) {
        const x = rand() * w;
        const y = rand() * h;
        const size = 3 + rand() * 8;
        ctx.globalAlpha = 0.5 + rand() * 0.45;
        ctx.lineWidth = 1 + rand() * 1.4;
        ctx.beginPath();
        ctx.moveTo(x - size, y);
        ctx.lineTo(x + size, y);
        ctx.moveTo(x, y - size);
        ctx.lineTo(x, y + size);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function drawNoise(
    ctx: CanvasRenderingContext2D,
    rand: () => number,
    w: number,
    h: number
): void {
    for (let i = 0; i < 6000; i += 1) {
        const x = Math.floor(rand() * w);
        const y = Math.floor(rand() * h);
        ctx.globalAlpha = 0.03 + rand() * 0.09;
        ctx.fillStyle = rand() > 0.5 ? "#FFFFFF" : "#000000";
        ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
}

function drawDecorations(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    decorations: Decoration[]
): void {
    const w = scene.outW;
    const h = scene.outH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    for (const decoration of decorations) {
        const rand = mulberry32(decoration.seed);
        switch (decoration.kind) {
            case "snow":
                drawSnow(ctx, rand, w, h);
                break;
            case "confetti":
                drawConfetti(ctx, rand, w, h);
                break;
            case "sparkle":
                drawSparkle(ctx, rand, w, h);
                break;
            case "noise":
                drawNoise(ctx, rand, w, h);
                break;
            default:
                break;
        }
    }
    ctx.restore();
}

/* --------------------------------------------------------------- render */

export function renderScene(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    opts: RenderOptions
): void {
    const bg = scene.bg ?? DEFAULT_BG;
    const corner = sceneCorner(scene);
    const screenMatrix = ctx.getTransform();

    ctx.clearRect(0, 0, scene.outW, scene.outH);

    // 背景铺满整个输出矩形
    const checker = bg.mode === "checker" ? checkerFill(ctx) : null;
    ctx.save();
    pathRoundRect(ctx, 0, 0, scene.outW, scene.outH, corner);
    if (bg.mode === "image" && opts.bgImage) {
        ctx.clip();
        drawCover(ctx, opts.bgImage, 0, 0, scene.outW, scene.outH);
    } else {
        ctx.fillStyle = checker ?? backgroundStyle(ctx, scene, bg);
        ctx.fill();
    }
    ctx.restore();

    // 内容框阴影（先铺背景再投影，保证屏幕与导出都能看到）
    const shadow = Math.max(0, bg.shadow ?? 0);
    if (shadow > 0) {
        ctx.save();
        pathRoundRect(
            ctx,
            scene.frame.x,
            scene.frame.y,
            scene.frame.w,
            scene.frame.h,
            corner
        );
        ctx.shadowColor = "rgba(0,0,0,.45)";
        ctx.shadowBlur = shadow;
        ctx.shadowOffsetY = Math.round(shadow / 3);
        ctx.fillStyle = shadowFillStyle(ctx, scene, bg, opts.bgImage, checker);
        ctx.fill();
        ctx.restore();
    }

    const effects = opts.effects;
    const flipX = effects.flipX === -1 ? -1 : 1;
    const flipY = effects.flipY === -1 ? -1 : 1;
    const iw = scene.imgW;
    const ih = scene.imgH;
    // Where the original content sits inside the (possibly frame-expanded) canvas.
    const contentX = (scene.procW - iw) / 2;
    const contentY = (scene.procH - ih) / 2;

    // 底图 + 标注共用同一个图像空间变换
    let imageMatrix: DOMMatrix | null = null;
    ctx.save();
    pathRoundRect(
        ctx,
        scene.proc.x,
        scene.proc.y,
        scene.proc.w,
        scene.proc.h,
        corner
    );
    ctx.clip();
    ctx.translate(scene.proc.x + scene.proc.w / 2, scene.proc.y + scene.proc.h / 2);
    ctx.rotate((scene.rotate * Math.PI) / 180);
    ctx.scale(flipX, flipY);
    ctx.translate(-scene.procW / 2, -scene.procH / 2);
    if (opts.image) {
        ctx.drawImage(opts.image, 0, 0, scene.procW, scene.procH);
    }
    // Annotations keep their authored coordinates; shift to the content origin.
    ctx.translate(contentX, contentY);
    imageMatrix = ctx.getTransform();

    for (const annotation of opts.annotations) {
        drawAnnotation(ctx, annotation, scene, opts, "none");
    }
    ctx.restore();

    // 装饰层回到输出坐标系（与调用方缩放矩阵兼容）
    const decorations = effects.decorations ?? [];
    if (decorations.length > 0) {
        ctx.save();
        ctx.setTransform(screenMatrix);
        drawDecorations(ctx, scene, decorations);
        ctx.restore();
    }

    // 选择态最后绘制，且不进入导出
    if (opts.showSelection !== false && opts.selectedId) {
        const selected = opts.annotations.find((a) => a.id === opts.selectedId);
        if (selected) {
            ctx.save();
            if (imageMatrix) {
                ctx.setTransform(imageMatrix);
            }
            drawSelection(ctx, selected, opts.handleScale ?? 1);
            ctx.restore();
        }
    }
}

export function compositeToBlob(
    scene: Scene,
    opts: RenderOptions
): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(scene.outW));
    canvas.height = Math.max(1, Math.round(scene.outH));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return Promise.reject(new Error("2d context unavailable"));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    renderScene(ctx, scene, {
        ...opts,
        selectedId: null,
        showSelection: false,
    });

    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error("export failed"));
            }
        }, "image/png");
    });
}

/**
 * 计算画布在屏幕上的尺寸与缩放。
 * zoom 为 `null` 时按可用区域完整适配；为数字时表示绝对显示比例（1 = 原图像素 1:1）。
 */
export function fitScreen(
    canvas: HTMLCanvasElement,
    scene: Scene,
    availW: number,
    availH: number,
    zoom: number | null
): ScreenFit {
    const safeW = Math.max(1, availW);
    const safeH = Math.max(1, availH);
    const fitScale = Math.min(1, safeW / scene.outW, safeH / scene.outH);
    const screenScale =
        zoom === null ? fitScale : clamp(zoom || 1, 0.1, 8);
    const cssW = Math.max(1, Math.round(scene.outW * screenScale));
    const cssH = Math.max(1, Math.round(scene.outH * screenScale));
    const dpr = Math.min(
        2,
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    );
    const pixelRatio = Math.max(
        1,
        Math.min(
            (cssW * dpr) / scene.outW,
            MAX_BACKING_SIDE / Math.max(scene.outW, scene.outH)
        )
    );

    canvas.width = Math.round(scene.outW * pixelRatio);
    canvas.height = Math.round(scene.outH * pixelRatio);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";

    return { cssW, cssH, pixelRatio, screenScale };
}

export function createMapper(
    scene: Scene,
    effects: EffectState
): (outX: number, outY: number) => { x: number; y: number } {
    const rotate = normalizeRotate(scene.rotate);
    const flipX = effects.flipX === -1 ? -1 : 1;
    const flipY = effects.flipY === -1 ? -1 : 1;
    const cx = scene.img.w / 2;
    const cy = scene.img.h / 2;
    const halfW = scene.imgW / 2;
    const halfH = scene.imgH / 2;

    if (
        typeof DOMMatrix !== "undefined" &&
        typeof DOMPoint !== "undefined"
    ) {
        const inverse = new DOMMatrix()
            .translate(cx, cy)
            .rotate(0, 0, rotate)
            .scale(flipX, flipY)
            .translate(-halfW, -halfH)
            .inverse();
        return (outX: number, outY: number) => {
            const point = inverse.transformPoint(
                new DOMPoint(outX - scene.img.x, outY - scene.img.y)
            );
            return { x: point.x, y: point.y };
        };
    }

    return createMapperFallback(scene, rotate, flipX, flipY);
}

function createMapperFallback(
    scene: Scene,
    rotate: number,
    flipX: number,
    flipY: number
): (outX: number, outY: number) => { x: number; y: number } {
    const rad = (rotate * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = cos * flipX;
    const b = sin * flipX;
    const c = -sin * flipY;
    const d = cos * flipY;
    const halfW = scene.imgW / 2;
    const halfH = scene.imgH / 2;
    const tx = scene.img.w / 2 + (a * -halfW + c * -halfH);
    const ty = scene.img.h / 2 + (b * -halfW + d * -halfH);
    const det = a * d - b * c;

    return (outX: number, outY: number) => {
        const px = outX - scene.img.x - tx;
        const py = outY - scene.img.y - ty;
        if (Math.abs(det) < 1e-9) {
            return { x: px, y: py };
        }
        return {
            x: (d * px - c * py) / det,
            y: (a * py - b * px) / det,
        };
    };
}

/* ----------------------------------------------------- bounds / hit test */

function isBoxType(a: Annotation): boolean {
    switch (a.type) {
        case "rectangle":
        case "ellipse":
        case "highlight":
        case "blur":
        case "pixelate":
        case "magnify":
        case "spotlight":
        case "cutout":
        case "clone":
        case "eraser":
            return true;
        default:
            return false;
    }
}

export function annotationBounds(
    a: Annotation,
    ctx?: CanvasRenderingContext2D
): Rect {
    const points = a.points;
    if (a.type === "freehand" && points && points.length > 0) {
        let minX = points[0][0];
        let maxX = points[0][0];
        let minY = points[0][1];
        let maxY = points[0][1];
        for (const [px, py] of points) {
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    const x = Math.min(a.x1, a.x2);
    const y = Math.min(a.y1, a.y2);
    const w = Math.abs(a.x2 - a.x1);
    const h = Math.abs(a.y2 - a.y1);

    if (a.type === "arrow") {
        const geo = arrowHeadGeometry(a);
        const minX = Math.min(a.x1, a.x2, geo.leftX, geo.rightX);
        const maxX = Math.max(a.x1, a.x2, geo.leftX, geo.rightX);
        const minY = Math.min(a.y1, a.y2, geo.leftY, geo.rightY);
        const maxY = Math.max(a.y1, a.y2, geo.leftY, geo.rightY);
        return {
            x: minX,
            y: minY,
            w: Math.max(1, maxX - minX + 1e-9),
            h: Math.max(1, maxY - minY + 1e-9),
        };
    }
    if (a.type === "line") {
        return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    }
    if (isBoxType(a)) {
        return { x, y, w, h };
    }
    if (a.type === "text") {
        return {
            x,
            y,
            w: w > 0 ? w : measureTextWidth(ctx, a),
            h: h > 0 ? h : textLines(a).length * lineHeightOf(a),
        };
    }
    return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
}

function pointSegmentDistance(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        return Math.hypot(px - x1, py - y1);
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTest(
    annotations: Annotation[],
    x: number,
    y: number,
    ctx?: CanvasRenderingContext2D
): Annotation | null {
    for (let i = annotations.length - 1; i >= 0; i -= 1) {
        const a = annotations[i];

        if (a.type === "line" || a.type === "arrow") {
            const threshold = (a.width ?? DEFAULT_WIDTH) + 8;
            if (pointSegmentDistance(x, y, a.x1, a.y1, a.x2, a.y2) <= threshold) {
                return a;
            }
            continue;
        }

        const b = annotationBounds(a, ctx);
        if (isBoxType(a)) {
            const pad = Math.max(a.width ?? DEFAULT_WIDTH, 6);
            if (
                x >= b.x - pad &&
                x <= b.x + b.w + pad &&
                y >= b.y - pad &&
                y <= b.y + b.h + pad
            ) {
                return a;
            }
            continue;
        }

        if (
            x >= b.x - 4 &&
            x <= b.x + b.w + 4 &&
            y >= b.y - 4 &&
            y <= b.y + b.h + 4
        ) {
            return a;
        }
    }
    return null;
}

/* -------------------------------------------------------- image helpers */

export function loadImageElement(src: string): Promise<HTMLImageElement> {
    const image = new Image();
    image.src = src;
    return image.decode().then(
        () => image,
        () => {
            throw new Error("image load failed");
        }
    );
}

export async function cropBaseImage(
    image: CanvasImageSource,
    rect: Rect
): Promise<HTMLImageElement> {
    const size = sourceSize(image);
    const x = Math.round(clamp(rect.x, 0, Math.max(0, size.w - 1)));
    const y = Math.round(clamp(rect.y, 0, Math.max(0, size.h - 1)));
    const w = Math.round(clamp(rect.w, 1, size.w - x));
    const h = Math.round(clamp(rect.h, 1, size.h - y));

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("2d context unavailable");
    }
    ctx.drawImage(image, x, y, w, h, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
        throw new Error("crop failed");
    }
    const url = URL.createObjectURL(blob);
    return loadImageElement(url);
}

export function detectAutoCrop(
    image: HTMLImageElement,
    tolerance = 10
): Rect | null {
    const iw = image.naturalWidth || image.width || 0;
    const ih = image.naturalHeight || image.height || 0;
    if (iw <= 0 || ih <= 0) {
        return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = iw;
    canvas.height = ih;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return null;
    }
    ctx.drawImage(image, 0, 0, iw, ih);

    let data: ImageData;
    try {
        data = ctx.getImageData(0, 0, iw, ih);
    } catch {
        return null;
    }
    const px = data.data;
    const tol = Math.max(0, tolerance);

    const indexOf = (x: number, y: number): number => (y * iw + x) * 4;
    const samePixel = (i: number, j: number): boolean => {
        for (let channel = 0; channel < 4; channel += 1) {
            if (Math.abs(px[i + channel] - px[j + channel]) > tol) {
                return false;
            }
        }
        return true;
    };
    const rowUniform = (y: number): boolean => {
        const ref = indexOf(0, y);
        for (let x = 1; x < iw; x += 1) {
            if (!samePixel(ref, indexOf(x, y))) {
                return false;
            }
        }
        return true;
    };
    const columnUniform = (x: number): boolean => {
        const ref = indexOf(x, 0);
        for (let y = 1; y < ih; y += 1) {
            if (!samePixel(ref, indexOf(x, y))) {
                return false;
            }
        }
        return true;
    };

    let top = 0;
    let bottom = ih - 1;
    let left = 0;
    let right = iw - 1;

    while (top <= bottom && rowUniform(top)) {
        top += 1;
    }
    while (bottom >= top && rowUniform(bottom)) {
        bottom -= 1;
    }
    if (top > bottom) {
        return null;
    }
    while (left <= right && columnUniform(left)) {
        left += 1;
    }
    while (right >= left && columnUniform(right)) {
        right -= 1;
    }
    if (left > right) {
        return null;
    }

    const w = right - left + 1;
    const h = bottom - top + 1;
    if (w === iw && h === ih) {
        return null;
    }
    return { x: left, y: top, w, h };
}
