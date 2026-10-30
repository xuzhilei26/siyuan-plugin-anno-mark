/** Aggregates every native effect implementation. */
import type { EffectRegistry } from "../types.ts";
import { ADJUSTMENT_IMPLS, ADJUSTMENT_FRAME_IDS } from "./adjustments.ts";
import { DRAWING_IMPLS, DRAWING_FRAME_IDS } from "./drawings.ts";
import { MANIPULATION_IMPLS, MANIPULATION_FRAME_IDS } from "./manipulations.ts";
import { FILTER_F1_IMPLS, FILTER_F1_FRAME_IDS } from "./filters-f1.ts";
import { FILTER_F2_IMPLS, FILTER_F2_FRAME_IDS } from "./filters-f2.ts";
import { FILTER_F3_IMPLS, FILTER_F3_FRAME_IDS } from "./filters-f3.ts";
import { FILTER_F4_IMPLS, FILTER_F4_FRAME_IDS } from "./filters-f4.ts";

/** id → implementation. Tier C ids are absent by design. */
export const EFFECT_IMPLS: EffectRegistry = {
    ...MANIPULATION_IMPLS,
    ...ADJUSTMENT_IMPLS,
    ...FILTER_F1_IMPLS,
    ...FILTER_F2_IMPLS,
    ...FILTER_F3_IMPLS,
    ...FILTER_F4_IMPLS,
    ...DRAWING_IMPLS,
};

/** Ids whose implementation expands the canvas (borders, shadows). */
export const FRAME_EFFECTS: ReadonlySet<string> = new Set([
    ...MANIPULATION_FRAME_IDS,
    ...ADJUSTMENT_FRAME_IDS,
    ...FILTER_F1_FRAME_IDS,
    ...FILTER_F2_FRAME_IDS,
    ...FILTER_F3_FRAME_IDS,
    ...FILTER_F4_FRAME_IDS,
    ...DRAWING_FRAME_IDS,
]);
