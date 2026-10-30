/**
 * Shared data contracts for the AnnoMark editor.
 *
 * Annotations live in original image pixel space; the layout layer maps them to
 * output pixels. Nothing in this module touches the DOM.
 */
import type { AppliedEffect } from "./effects/types.ts";

/** Translator signature used by every UI module. */
export type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** All 21 editor tools, in toolbar order. */
export type ToolId =
    | "select" | "rectangle" | "ellipse" | "line" | "arrow" | "freehand" | "text"
    | "speech" | "step" | "image" | "clone" | "emoji" | "cursor" | "highlight"
    | "eraser" | "blur" | "pixelate" | "magnify" | "spotlight" | "crop" | "cutout";

/** Toolbar order (select first; crop/cutout are grouped separately in the UI). */
export const TOOL_ORDER: ToolId[] = [
    "select", "rectangle", "ellipse", "line", "arrow", "freehand", "text",
    "speech", "step", "image", "clone", "emoji", "cursor", "highlight",
    "eraser", "blur", "pixelate", "magnify", "spotlight", "crop", "cutout",
];

/** Lowercase keyboard letter → tool. */
export const TOOL_SHORTCUTS: Record<string, ToolId> = {
    v: "select",
    r: "rectangle",
    e: "ellipse",
    l: "line",
    a: "arrow",
    f: "freehand",
    t: "text",
    o: "speech",
    n: "step",
    i: "image",
    d: "clone",
    j: "emoji",
    k: "cursor",
    h: "highlight",
    w: "eraser",
    b: "blur",
    p: "pixelate",
    m: "magnify",
    s: "spotlight",
    c: "crop",
    u: "cutout",
};

/** Every annotation kind (tools that leave a mark on the canvas). */
export type AnnotationType = Exclude<ToolId, "select" | "crop">;

export type BorderStyle = "solid" | "dash" | "dot" | "dashdot";
export type TextAlign = "left" | "center" | "right";
export type StepType = "numbers" | "letters" | "roman";
export type CursorType = "arrow" | "hand" | "ibeam" | "cross";

/** A point in image pixel space. */
export type Point = [number, number];

export interface ShadowState {
    enabled: boolean;
    color: string;
    blur: number;
    opacity: number;
    x: number;
    y: number;
}

/** Fields shared by every annotation. */
export interface AnnoCommon {
    id: string;
    stroke: string;
    fill: string;
    width: number;
    borderStyle: BorderStyle;
    corner: number;
    shadow: ShadowState;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    text?: string;
    textColor?: string;
    fontFamily?: string;
    fontSize?: number;
    align?: TextAlign;
    bold?: boolean;
    italic?: boolean;
    stepType?: StepType;
    stepValue?: number;
    strength?: number;
    spotlightBlur?: number;
    effectEllipse?: boolean;
    tail?: boolean;
    points?: Point[];
    /** image / clone 标注的资源地址（data URL 或 assets 路径） */
    src?: string;
    /** clone 的源区域左上角（图片像素） */
    srcX?: number;
    srcY?: number;
    emoji?: string;
    cursorType?: CursorType;
}

/** Discriminated union of the 19 annotation kinds (all tools except select/crop). */
export type Annotation =
    | (AnnoCommon & { type: "rectangle" })
    | (AnnoCommon & { type: "ellipse" })
    | (AnnoCommon & { type: "line" })
    | (AnnoCommon & { type: "arrow" })
    | (AnnoCommon & { type: "freehand" })
    | (AnnoCommon & { type: "text" })
    | (AnnoCommon & { type: "speech" })
    | (AnnoCommon & { type: "step" })
    | (AnnoCommon & { type: "image" })
    | (AnnoCommon & { type: "clone" })
    | (AnnoCommon & { type: "emoji" })
    | (AnnoCommon & { type: "cursor" })
    | (AnnoCommon & { type: "highlight" })
    | (AnnoCommon & { type: "eraser" })
    | (AnnoCommon & { type: "blur" })
    | (AnnoCommon & { type: "pixelate" })
    | (AnnoCommon & { type: "magnify" })
    | (AnnoCommon & { type: "spotlight" })
    | (AnnoCommon & { type: "cutout" });

/** Left panel background composition state. */
export interface BgState {
    /** 0–200, default 24 */
    margin: number;
    /** 0–200, default 0 */
    padding: number;
    /** default true */
    smartPadding: boolean;
    /** 0–50, default 8 */
    corner: number;
    /** 0–100, default 30 */
    shadow: number;
    ratio: string;
    mode: "solid" | "gradient" | "image" | "checker";
    /** preset index; -1 means a custom gradient */
    gradient: number;
    gradientFrom: string;
    gradientTo: string;
    solid: string;
    /** empty string when no image is selected */
    imageSrc: string;
}

/** 程序化装饰图元（旧版元数据；读取时迁移为效果栈） */
export interface Decoration {
    kind: "snow" | "confetti" | "sparkle" | "noise";
    seed: number;
}

/** Right panel effect state; `rotate` is baked to 0 when exported. */
export interface EffectState {
    /** parameterized effect stack, applied in order over the base image */
    stack: AppliedEffect[];
    /** 0/90/180/270 */
    rotate: number;
    /** 1 | -1 */
    flipX: number;
    flipY: number;
    /** @deprecated legacy CSS filters, migrated into `stack` on read */
    filters?: string[];
    /** @deprecated legacy decorations, migrated into `stack` on read */
    decorations?: Decoration[];
}

/** PNG-embedded project metadata, version 2. */
export interface ProjectMetaV2 {
    v: 2;
    plugin: "anno-mark";
    annotations: Annotation[];
    effects: EffectState;
    bg: BgState;
    originalFileName?: string;
    originalHash?: string;
    savedAt?: number;
}

/** Alias kept for older call sites. */
export type ProjectMeta = ProjectMetaV2;

export interface ToolOptions {
    stroke: string;
    fill: string;
    textColor: string;
    width: number;
    borderStyle: BorderStyle;
    corner: number;
    fontFamily: string;
    fontSize: number;
    align: TextAlign;
    bold: boolean;
    italic: boolean;
    stepType: StepType;
    stepStart: number;
    strength: number;
    spotlightBlur: number;
    effectEllipse: boolean;
    tail: boolean;
    cursorType: CursorType;
    shadow: ShadowState;
}

/** A reusable tool-style preset (custom saved or built-in). */
export interface StyleTemplate {
    id: string;
    name: string;
    tool: ToolId;
    opts: ToolOptions;
    builtin?: boolean;
}

export const META_KEY = "anno-mark";

export const ORIGINALS_DIR =
    "data/storage/petal/siyuan-plugin-anno-mark/originals";

/** 24 solid swatches (transparent is exposed separately via TRANSPARENT). */
export const PALETTE: string[] = [
    "#FFFFFF", "#000000", "#F03E3E", "#F59F00", "#2F9E44", "#1098AD",
    "#1971C2", "#7048E8", "#F76808", "#FFD60A", "#30A46C", "#3E83F2",
    "#8E4EC6", "#E93D82", "#8B8D98", "#D8DADB", "#7C2D12", "#065F46",
    "#1E3A8A", "#4C1D95", "#9CA3AF", "#6B7280", "#374151", "#111827",
];

export const TRANSPARENT = "transparent";

/** 8 gradient presets, identical to the prototype. */
export const GRADIENT_PRESETS: Array<[string, string]> = [
    ["#8B5CF6", "#22D3EE"],
    ["#F97316", "#FACC15"],
    ["#EC4899", "#8B5CF6"],
    ["#10B981", "#3B82F6"],
    ["#0EA5E9", "#1E293B"],
    ["#F43F5E", "#F59E0B"],
    ["#64748B", "#1E1E24"],
    ["#14B8A6", "#84CC16"],
];

export const FONT_FAMILIES: string[] = [
    "Segoe UI",
    "Inter",
    "Arial",
    "Georgia",
    "Times New Roman",
    "Consolas",
];

export const BORDER_STYLES: BorderStyle[] = ["solid", "dash", "dot", "dashdot"];

export const RATIO_OPTIONS: string[] = [
    "Auto", "1:1", "4:3", "3:2", "16:9", "5:3", "9:16", "3:4", "2:3",
];

export const STEP_TYPES: StepType[] = ["numbers", "letters", "roman"];

export const CURSOR_TYPES: CursorType[] = ["arrow", "hand", "ibeam", "cross"];

export const DEFAULT_BG: BgState = {
    margin: 24,
    padding: 0,
    smartPadding: true,
    corner: 8,
    shadow: 30,
    ratio: "Auto",
    mode: "gradient",
    gradient: 0,
    gradientFrom: "#8B5CF6",
    gradientTo: "#22D3EE",
    solid: "#3E83F2",
    imageSrc: "",
};

export const DEFAULT_EFFECTS: EffectState = {
    stack: [],
    rotate: 0,
    flipX: 1,
    flipY: 1,
};

/** Fresh tool options; the shadow object is not shared between calls. */
export function createOptions(): ToolOptions {
    return {
        stroke: "#F03E3E",
        fill: "transparent",
        textColor: "#FFFFFF",
        width: 4,
        borderStyle: "solid",
        corner: 0,
        fontFamily: "Segoe UI",
        fontSize: 24,
        align: "left",
        bold: true,
        italic: false,
        stepType: "numbers",
        stepStart: 1,
        strength: 60,
        spotlightBlur: 8,
        effectEllipse: false,
        tail: true,
        cursorType: "arrow",
        shadow: {
            enabled: false,
            color: "#000000",
            blur: 12,
            opacity: 0.5,
            x: 4,
            y: 4,
        },
    };
}

/** Property visibility rules, mirroring the prototype `OPT_VIS`. */
export const OPT_VIS: Record<string, ToolId[]> = {
    stroke: ["rectangle", "ellipse", "line", "arrow", "freehand", "speech", "text", "step"],
    fill: ["rectangle", "ellipse", "speech", "step", "highlight"],
    textColor: ["text", "speech", "step"],
    width: ["rectangle", "ellipse", "line", "arrow", "freehand", "speech", "step", "text"],
    borderStyle: ["rectangle", "ellipse", "line", "freehand"],
    corner: ["rectangle", "speech"],
    fontFamily: ["text", "speech"],
    fontSize: ["text", "step", "speech"],
    align: ["text", "speech"],
    bold: ["text", "speech", "step"],
    italic: ["text", "speech"],
    stepType: ["step"],
    stepStart: ["step"],
    strength: ["blur", "pixelate", "magnify", "spotlight"],
    spotlightBlur: ["spotlight"],
    effectEllipse: ["magnify", "spotlight"],
    tail: ["speech", "step"],
    cursorType: ["cursor"],
    shadow: ["rectangle", "ellipse", "line", "arrow", "freehand", "text", "speech", "step"],
};
