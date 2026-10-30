/**
 * The 232-effect catalog, generated from ShareX.ImageEditor source. Stored as a
 * typed module so it resolves in both Vite and plain Node tests.
 */
import { RAW_EFFECTS } from "./data/effects.ts";
import type { RawEffectData } from "./data/effects.ts";
import type {
    AppliedEffect,
    DelegateAction,
    EffectCategory,
    EffectDef,
    EffectParamDef,
    ParamValue,
} from "./types.ts";
import { EFFECT_CATEGORY_ORDER } from "./types.ts";

const CATEGORY_MAP: Record<RawEffectData["category"], EffectCategory> = {
    manipulations: "manipulation",
    adjustments: "adjustment",
    filters: "filter",
    drawings: "drawing",
};

/** Tier C entries execute through existing editor tools. */
const DELEGATES: Record<string, DelegateAction> = {
    crop_image: "crop",
    auto_crop_image: "autoCrop",
    resize_image: "resize",
    scale: "scale",
    resize_canvas: "canvas",
    flip: "flip",
    flip_horizontal: "flipH",
    flip_vertical: "flipV",
    rotate_90_clockwise: "rotate90",
    rotate_90_counter_clockwise: "rotate270",
    rotate_180: "rotate180",
    rotate_custom_angle: "rotateCustom",
    draw_background: "bgSolid",
    draw_background_image: "bgImage",
    draw_image: "image",
    draw_line: "line",
    draw_shape: "shape",
    draw_text: "text",
    fake_cursor: "cursor",
};

/** Ordered exactly like ShareX: category, then name. */
export const EFFECT_CATALOG: EffectDef[] = RAW_EFFECTS
    .map((raw) => ({
        id: raw.id,
        name: raw.name,
        category: CATEGORY_MAP[raw.category],
        labelKey: `effect.${raw.id}`,
        tier: raw.tier,
        batch: raw.batch ?? undefined,
        params: raw.params,
        delegate: DELEGATES[raw.id],
    }))
    .sort((a, b) => {
        const cat =
            EFFECT_CATEGORY_ORDER.indexOf(a.category) -
            EFFECT_CATEGORY_ORDER.indexOf(b.category);
        return cat !== 0 ? cat : a.name.localeCompare(b.name);
    });

const BY_ID = new Map<string, EffectDef>(
    EFFECT_CATALOG.map((def) => [def.id, def])
);

export const EFFECT_CATEGORIES: Array<{
    id: EffectCategory;
    labelKey: string;
    hintKey: string;
}> = [
    { id: "manipulation", labelKey: "effects.cat.manipulation", hintKey: "effects.hint.manipulation" },
    { id: "adjustment", labelKey: "effects.cat.adjustment", hintKey: "effects.hint.adjustment" },
    { id: "filter", labelKey: "effects.cat.filter", hintKey: "effects.hint.filter" },
    { id: "drawing", labelKey: "effects.cat.drawing", hintKey: "effects.hint.drawing" },
];

export function findEffect(id: string): EffectDef | undefined {
    return BY_ID.get(id);
}

export function categoryCounts(
    list: EffectDef[] = EFFECT_CATALOG
): Record<EffectCategory, number> {
    const counts: Record<EffectCategory, number> = {
        manipulation: 0,
        adjustment: 0,
        filter: 0,
        drawing: 0,
    };
    for (const def of list) {
        counts[def.category] += 1;
    }
    return counts;
}

/** True when the effect applies immediately (no parameter popup). */
export function hasParams(def: EffectDef): boolean {
    return def.params.length > 0;
}

/** Default parameter dictionary for an effect id. */
export function defaultParams(def: EffectDef): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {};
    for (const param of def.params) {
        out[param.key] = param.default;
    }
    return out;
}

/** Builds a fresh stack entry with defaults filled in. */
export function createAppliedEffect(id: string, seed = 1): AppliedEffect | null {
    const def = findEffect(id);
    if (!def) {
        return null;
    }
    return { id, params: defaultParams(def), seed };
}

/** Clamps / coerces a raw value to the parameter schema. */
export function normalizeParamValue(
    param: EffectParamDef,
    value: unknown
): ParamValue {
    if (param.type === "number") {
        const num = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(num)) {
            return param.default;
        }
        let next = num;
        if (typeof param.min === "number" && next < param.min) {
            next = param.min;
        }
        if (typeof param.max === "number" && next > param.max) {
            next = param.max;
        }
        if (param.integer) {
            next = Math.round(next);
        }
        return next;
    }
    if (param.type === "bool") {
        return typeof value === "boolean" ? value : value === "true";
    }
    if (param.type === "enum") {
        const list = param.options ?? [];
        const candidate = typeof value === "string" ? value : String(value ?? "");
        return list.some((option) => option.value === candidate)
            ? candidate
            : param.default;
    }
    if (param.type === "color") {
        return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)
            ? value
            : param.default;
    }
    return typeof value === "string" ? value : String(value ?? "");
}

/** Fills missing keys and repairs invalid values in a stack entry. */
export function sanitizeAppliedEffect(value: unknown): AppliedEffect | null {
    if (!value || typeof value !== "object") {
        return null;
    }
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) {
        return null;
    }
    const def = findEffect(id);
    const rawParams =
        record.params && typeof record.params === "object"
            ? (record.params as Record<string, unknown>)
            : {};
    const params: Record<string, ParamValue> = {};
    if (def) {
        for (const param of def.params) {
            params[param.key] = normalizeParamValue(
                param,
                Object.prototype.hasOwnProperty.call(rawParams, param.key)
                    ? rawParams[param.key]
                    : param.default
            );
        }
    } else {
        for (const [key, raw] of Object.entries(rawParams)) {
            if (
                typeof raw === "number" ||
                typeof raw === "string" ||
                typeof raw === "boolean"
            ) {
                params[key] = raw;
            }
        }
    }
    const seed =
        typeof record.seed === "number" && Number.isFinite(record.seed)
            ? Math.floor(record.seed)
            : 1;
    return { id, params, seed };
}
