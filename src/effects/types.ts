/**
 * Parameterized image-effect contracts (ported from ShareX.ImageEditor).
 *
 * Pixel effects run on the base image only; annotations are composited on top.
 * Geometry / tool effects (tier C) are delegated to the editor and never enter
 * the pixel stack.
 */

/** ShareX category names, mapped to the panel groups. */
export type EffectCategory = "manipulation" | "adjustment" | "filter" | "drawing";

/** A = exact port, B = procedural canvas approximation, C = delegated to a tool. */
export type EffectTier = "A" | "B" | "C";

export type EffectBatch = "F1" | "F2" | "F3" | "F4";

export type ParamValue = number | string | boolean;

export type ParamDict = Record<string, ParamValue>;

export type EffectParamType = "number" | "color" | "bool" | "enum" | "text" | "file";

export interface EffectParamOption {
    value: string;
    label: string;
}

export interface EffectParamDef {
    key: string;
    /** English label from ShareX, used when no translation exists. */
    label: string;
    type: EffectParamType;
    default: ParamValue;
    min?: number;
    max?: number;
    step?: number;
    integer?: boolean;
    options?: EffectParamOption[];
}

/** A concrete effect instance in the stack. */
export interface AppliedEffect {
    id: string;
    params: ParamDict;
    /** Deterministic seed for noise / particle effects. */
    seed?: number;
}

/** Delegated behaviours implemented by the editor instead of the pixel engine. */
export type DelegateAction =
    | "crop" | "autoCrop" | "resize" | "scale" | "canvas"
    | "flip" | "flipH" | "flipV"
    | "rotate90" | "rotate270" | "rotate180" | "rotateCustom"
    | "bgSolid" | "bgImage"
    | "image" | "line" | "shape" | "text" | "cursor";

export interface EffectDef {
    id: string;
    category: EffectCategory;
    /** English fallback name. */
    name: string;
    /** i18n key, always `effect.<id>`. */
    labelKey: string;
    tier: EffectTier;
    batch?: EffectBatch;
    params: EffectParamDef[];
    /** Present for tier C entries. */
    delegate?: DelegateAction;
}

/** Padding a frame effect adds around the content, in effect-space pixels. */
export interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface EffectEnv {
    id: string;
    /** preview scale (1 = full resolution export). */
    scale: number;
    seed: number;
    /** Scales a pixel-unit parameter to the current render resolution. */
    px(value: number): number;
    /** Deterministic PRNG in [0,1), re-seeded per effect instance. */
    rand(): number;
}

/**
 * A native effect. Returning a pad object expands the output (frames).
 */
export type EffectImpl = (
    src: ImageData,
    params: ParamDict,
    env: EffectEnv
) => ImageData | { data: ImageData; pad: Insets };

/**
 * Runtime registry. Tier C ids are absent; every A/B id must exist.
 */
export type EffectRegistry = Record<string, EffectImpl>;

/** Shared empty insets (never mutated). */
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Sums two insets. */
export function addInsets(a: Insets, b: Insets): Insets {
    return {
        top: a.top + b.top,
        right: a.right + b.right,
        bottom: a.bottom + b.bottom,
        left: a.left + b.left,
    };
}

/** True when every side is zero. */
export function isZeroInsets(pad: Insets): boolean {
    return pad.top === 0 && pad.right === 0 && pad.bottom === 0 && pad.left === 0;
}

/** Effect category order used by the panel and the fixture. */
export const EFFECT_CATEGORY_ORDER: EffectCategory[] = [
    "manipulation",
    "adjustment",
    "filter",
    "drawing",
];
