/**
 * Effect stack engine: runs native effects over the base image in order and
 * caches the processed result.
 *
 * Pixel effects run before frame effects so borders never get blurred by later
 * pixel work (a documented difference from ShareX). Preview runs at a reduced
 * long edge; export runs at full resolution.
 */
import { findEffect } from "./catalog.ts";
import { EFFECT_IMPLS, FRAME_EFFECTS } from "./impl/index.ts";
import { mulberry32 } from "./rand.ts";
import { NO_INSETS, addInsets, isZeroInsets } from "./types.ts";
import type {
    AppliedEffect,
    EffectEnv,
    Insets,
    ParamDict,
} from "./types.ts";

export const PREVIEW_MAX_SIDE = 1600;

export interface ProcessedBase {
    canvas: HTMLCanvasElement;
    pad: Insets;
    /** 1 for export; preview ratio otherwise. */
    scale: number;
    width: number;
    height: number;
    /** False when the stack had nothing to run (source returned as-is). */
    rendered: boolean;
}

export interface RenderEffectOptions {
    /** Identity of the source pixels (src / data URL / revision). */
    baseKey: string;
    /** Long-edge limit; omit for full-resolution export. */
    maxSide?: number;
}

const CACHE_LIMIT = 12;
const cache = new Map<string, ProcessedBase>();

/** Stable signature of a stack (params are serialized in key order). */
export function stackSignature(stack: AppliedEffect[]): string {
    return JSON.stringify(
        stack.map((item) => {
            const keys = Object.keys(item.params ?? {}).sort();
            const params = keys.map((key) => [key, item.params[key]]);
            return [item.id, params, item.seed ?? 1];
        })
    );
}

export function effectCacheKey(
    baseKey: string,
    stack: AppliedEffect[],
    maxSide?: number
): string {
    return `${baseKey}|${maxSide ?? 0}|${stackSignature(stack)}`;
}

export function clearEffectCache(): void {
    cache.clear();
}

/** True when the id has a native implementation that runs in the pixel engine. */
export function isRunnable(id: string): boolean {
    if (id === "custom_filter") {
        return true;
    }
    const def = findEffect(id);
    if (!def || def.delegate) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(EFFECT_IMPLS, id);
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
        throw new Error("2d context unavailable");
    }
    return ctx;
}

/** Reads a canvas into ImageData (Node tests may supply a stub canvas). */
export function readImageData(canvas: HTMLCanvasElement): ImageData {
    return context2d(canvas).getImageData(
        0,
        0,
        Math.max(1, canvas.width),
        Math.max(1, canvas.height)
    );
}

export function canvasFromImageData(data: ImageData): HTMLCanvasElement {
    const canvas = createCanvas(data.width, data.height);
    context2d(canvas).putImageData(data, 0, 0);
    return canvas;
}

function downscale(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
    const canvas = createCanvas(width, height);
    const ctx = context2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
}

/** Applies a legacy CSS filter string (used by migrated custom filters). */
function applyCssFilter(data: ImageData, css: string): ImageData {
    const source = canvasFromImageData(data);
    const canvas = createCanvas(data.width, data.height);
    const ctx = context2d(canvas);
    ctx.filter = css || "none";
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
    return readImageData(canvas);
}

function paramsOf(item: AppliedEffect): ParamDict {
    return item.params ?? {};
}

function runEffect(
    data: ImageData,
    item: AppliedEffect,
    scale: number,
    seed: number
): { data: ImageData; pad: Insets } {
    if (item.id === "custom_filter") {
        const css = String(paramsOf(item).css ?? "none");
        return { data: applyCssFilter(data, css), pad: NO_INSETS };
    }
    const impl = EFFECT_IMPLS[item.id];
    if (!impl) {
        return { data, pad: NO_INSETS };
    }
    const env: EffectEnv = {
        id: item.id,
        scale,
        seed,
        px: (value: number) => value * scale,
        rand: mulberry32(seed),
    };
    const result = impl(data, paramsOf(item), env);
    if (result && typeof result === "object" && "pad" in result && "data" in result) {
        return { data: result.data, pad: result.pad };
    }
    return { data: result as ImageData, pad: NO_INSETS };
}

/**
 * Runs the stack over the base image. Returns the processed canvas plus the
 * frame padding needed by the scene layout.
 */
export function renderEffects(
    source: HTMLCanvasElement,
    stack: AppliedEffect[],
    opts: RenderEffectOptions
): ProcessedBase {
    const runnable = (stack ?? []).filter((item) => item && isRunnable(item.id));
    const width = Math.max(1, source.width);
    const height = Math.max(1, source.height);

    if (runnable.length === 0) {
        return {
            canvas: source,
            pad: NO_INSETS,
            scale: 1,
            width,
            height,
            rendered: false,
        };
    }

    const key = effectCacheKey(opts.baseKey, stack, opts.maxSide);
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }

    const limit = opts.maxSide && opts.maxSide > 0 ? opts.maxSide : 0;
    const scale = limit > 0 ? Math.min(1, limit / Math.max(width, height)) : 1;
    const scaledW = Math.max(1, Math.round(width * scale));
    const scaledH = Math.max(1, Math.round(height * scale));

    let data = readImageData(
        scale < 1 ? downscale(source, scaledW, scaledH) : source
    );
    let pad = NO_INSETS;

    const baseSeed = 1;
    const pixelItems = runnable.filter((item) => !FRAME_EFFECTS.has(item.id));
    const frameItems = runnable.filter((item) => FRAME_EFFECTS.has(item.id));

    for (const item of pixelItems) {
        const result = runEffect(data, item, scale, (item.seed ?? baseSeed) + baseSeed);
        data = result.data;
    }
    for (const item of frameItems) {
        const result = runEffect(data, item, scale, (item.seed ?? baseSeed) + baseSeed);
        data = result.data;
        if (!isZeroInsets(result.pad)) {
            pad = addInsets(pad, result.pad);
        }
    }

    const processed: ProcessedBase = {
        canvas: canvasFromImageData(data),
        pad,
        scale,
        width: data.width,
        height: data.height,
        rendered: true,
    };

    cache.set(key, processed);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        cache.delete(oldest);
    }
    return processed;
}
