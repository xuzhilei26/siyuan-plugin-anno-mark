/**
 * PNG text-chunk (tEXt) persistence for annotation projects.
 *
 * Zero dependencies: runs both in the SiYuan plugin runtime (browser) and in
 * plain Node tests. All byte handling is done on Uint8Array so no DOM or Node
 * specific API is required.
 */
import { DEFAULT_BG, DEFAULT_EFFECTS, META_KEY, ORIGINALS_DIR } from "./types.ts";
import type {
    Annotation,
    BgState,
    Decoration,
    EffectState,
    ProjectMetaV2,
} from "./types.ts";
import {
    createAppliedEffect,
    findEffect,
    normalizeParamValue,
    sanitizeAppliedEffect,
} from "./effects/catalog.ts";
import type { AppliedEffect, ParamValue } from "./effects/types.ts";

export { DEFAULT_BG, DEFAULT_EFFECTS } from "./types.ts";

/** Standard 8-byte PNG file signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Every annotation type accepted in v2 metadata. */
const ANNOTATION_TYPES = new Set<string>([
    "rectangle", "ellipse", "line", "arrow", "freehand", "text", "speech", "step",
    "image", "clone", "emoji", "cursor", "highlight", "eraser", "blur", "pixelate",
    "magnify", "spotlight", "cutout",
]);

/** Legacy v1 annotation types. */
const V1_ANNOTATION_TYPES = new Set<string>(["rect", "arrow", "text"]);

const BORDER_STYLE_VALUES = new Set<string>(["solid", "dash", "dot", "dashdot"]);
const TEXT_ALIGN_VALUES = new Set<string>(["left", "center", "right"]);
const STEP_TYPE_VALUES = new Set<string>(["numbers", "letters", "roman"]);
const CURSOR_TYPE_VALUES = new Set<string>(["arrow", "hand", "ibeam", "cross"]);
const BG_MODE_VALUES = new Set<string>(["solid", "gradient", "image", "checker"]);

/** Default shadow used when upgrading v1 annotations. */
const DEFAULT_SHADOW = {
    enabled: false,
    color: "#000000",
    blur: 12,
    opacity: 0.5,
    x: 4,
    y: 4,
};

/** A parsed PNG chunk; `raw` holds the exact original bytes (length + type + data + crc). */
interface PngChunk {
    type: string;
    data: Uint8Array;
    raw: Uint8Array;
}

/** CRC32 lookup table (polynomial 0xEDB88320, as used by PNG). */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC32 over a byte range; returns an unsigned 32-bit value (same as PNG CRCs). */
function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Reads a big-endian unsigned 32-bit integer at `offset`. */
function readU32(bytes: Uint8Array, offset: number): number {
    return (
        ((bytes[offset] << 24) |
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3]) >>> 0
    );
}

/** Writes a big-endian unsigned 32-bit integer at `offset`. */
function writeU32(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
}

/** Decodes bytes as Latin-1 (one character per byte). */
function latin1FromBytes(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}

/** Encodes a string as Latin-1 (one byte per character, low 8 bits only). */
function latin1ToBytes(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        out[i] = text.charCodeAt(i) & 0xff;
    }
    return out;
}

/** True when `bytes` starts with the PNG signature. */
function hasPngSignature(bytes: Uint8Array): boolean {
    if (bytes.length < 8) {
        return false;
    }
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Splits a PNG into chunks, keeping the raw bytes of every chunk untouched.
 * Returns null when the signature is missing or a chunk length overruns the file.
 */
function parseChunks(bytes: Uint8Array): PngChunk[] | null {
    if (!hasPngSignature(bytes)) {
        return null;
    }
    const chunks: PngChunk[] = [];
    let offset = 8;
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) {
            return null;
        }
        const length = readU32(bytes, offset);
        const typeStart = offset + 4;
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const end = dataEnd + 4;
        if (end > bytes.length) {
            return null;
        }
        const type = latin1FromBytes(bytes.subarray(typeStart, dataStart));
        chunks.push({
            type,
            data: bytes.subarray(dataStart, dataEnd),
            raw: bytes.subarray(offset, end),
        });
        offset = end;
        if (type === "IEND") {
            break;
        }
    }
    return chunks;
}

/** Builds a complete tEXt chunk (length + type + data + crc); value must be ASCII. */
function buildTextChunk(keyword: string, value: string): Uint8Array {
    const keywordBytes = latin1ToBytes(keyword);
    const valueBytes = latin1ToBytes(value);
    const payloadLength = keywordBytes.length + 1 + valueBytes.length;
    const chunk = new Uint8Array(4 + 4 + payloadLength + 4);
    writeU32(chunk, 0, payloadLength);
    chunk.set(latin1ToBytes("tEXt"), 4);
    chunk.set(keywordBytes, 8);
    chunk[8 + keywordBytes.length] = 0;
    chunk.set(valueBytes, 8 + keywordBytes.length + 1);
    const crc = crc32(chunk.subarray(4, 8 + payloadLength));
    writeU32(chunk, 8 + payloadLength, crc);
    return chunk;
}

/** Returns the keyword part of a tEXt chunk payload (everything before the first 0x00). */
function textKeyword(data: Uint8Array): string {
    const separator = data.indexOf(0);
    return latin1FromBytes(separator === -1 ? data : data.subarray(0, separator));
}

/**
 * Reads the text of the first tEXt chunk whose keyword matches.
 *
 * Returns null when the buffer is not a valid PNG, the structure is corrupt,
 * or no chunk with that keyword exists. Never throws.
 */
export function readPngText(bytes: Uint8Array, keyword: string): string | null {
    const chunks = parseChunks(bytes);
    if (!chunks) {
        return null;
    }
    for (const chunk of chunks) {
        if (chunk.type !== "tEXt") {
            continue;
        }
        if (textKeyword(chunk.data) !== keyword) {
            continue;
        }
        const separator = chunk.data.indexOf(0);
        if (separator === -1) {
            return "";
        }
        return latin1FromBytes(chunk.data.subarray(separator + 1));
    }
    return null;
}

/**
 * Writes a tEXt chunk, replacing every existing chunk with the same keyword.
 *
 * The new chunk is inserted right after IHDR; all other chunks keep their
 * original bytes and order. Throws "Not a PNG file" when the input is not PNG.
 * `value` must be ASCII (use encodeMeta for arbitrary text).
 */
export function writePngText(bytes: Uint8Array, keyword: string, value: string): Uint8Array {
    if (!hasPngSignature(bytes)) {
        throw new Error("Not a PNG file");
    }
    const chunks = parseChunks(bytes);
    if (!chunks) {
        throw new Error("Not a PNG file");
    }
    const ihdrIndex = chunks.findIndex((chunk) => chunk.type === "IHDR");
    if (ihdrIndex === -1) {
        throw new Error("Not a PNG file");
    }

    const textChunk = buildTextChunk(keyword, value);
    const parts: Uint8Array[] = [bytes.subarray(0, 8)];
    let inserted = false;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.type === "tEXt" && textKeyword(chunk.data) === keyword) {
            continue; // drop stale chunk for this keyword to avoid duplicates
        }
        parts.push(chunk.raw);
        if (i === ihdrIndex) {
            parts.push(textChunk);
            inserted = true;
        }
    }
    if (!inserted) {
        parts.splice(1, 0, textChunk);
    }

    let total = 0;
    for (const part of parts) {
        total += part.length;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

/**
 * Serializes project metadata into an ASCII-only tEXt value.
 *
 * Percent-encoding keeps non-ASCII (e.g. Chinese) text representable in tEXt.
 */
export function encodeMeta(meta: ProjectMetaV2): string {
    return encodeURIComponent(JSON.stringify(meta));
}

/** True when `value` is a finite number. */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** True when `value` is a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation for a shadow state. */
function isShadowState(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.enabled === "boolean" &&
        typeof value.color === "string" &&
        isFiniteNumber(value.blur) &&
        isFiniteNumber(value.opacity) &&
        isFiniteNumber(value.x) &&
        isFiniteNumber(value.y)
    );
}

/** Structural validation for a freehand point list. */
function isPointList(value: unknown): boolean {
    if (!Array.isArray(value)) {
        return false;
    }
    for (const point of value) {
        if (!Array.isArray(point) || point.length !== 2) {
            return false;
        }
        if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
            return false;
        }
    }
    return true;
}

/** Structural validation for a v2 annotation; mirrors the AnnoCommon interface. */
function isAnnotation(value: unknown): value is Annotation {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.id !== "string") {
        return false;
    }
    if (typeof value.type !== "string" || !ANNOTATION_TYPES.has(value.type)) {
        return false;
    }
    if (typeof value.stroke !== "string" || typeof value.fill !== "string") {
        return false;
    }
    if (
        !isFiniteNumber(value.width) ||
        !isFiniteNumber(value.corner) ||
        !isFiniteNumber(value.x1) ||
        !isFiniteNumber(value.y1) ||
        !isFiniteNumber(value.x2) ||
        !isFiniteNumber(value.y2)
    ) {
        return false;
    }
    if (typeof value.borderStyle !== "string" || !BORDER_STYLE_VALUES.has(value.borderStyle)) {
        return false;
    }
    if (!isShadowState(value.shadow)) {
        return false;
    }
    if (value.text !== undefined && typeof value.text !== "string") {
        return false;
    }
    if (value.textColor !== undefined && typeof value.textColor !== "string") {
        return false;
    }
    if (value.fontFamily !== undefined && typeof value.fontFamily !== "string") {
        return false;
    }
    if (value.fontSize !== undefined && (!isFiniteNumber(value.fontSize) || value.fontSize <= 0)) {
        return false;
    }
    if (value.align !== undefined && (typeof value.align !== "string" || !TEXT_ALIGN_VALUES.has(value.align))) {
        return false;
    }
    if (value.bold !== undefined && typeof value.bold !== "boolean") {
        return false;
    }
    if (value.italic !== undefined && typeof value.italic !== "boolean") {
        return false;
    }
    if (value.stepType !== undefined && (typeof value.stepType !== "string" || !STEP_TYPE_VALUES.has(value.stepType))) {
        return false;
    }
    if (value.stepValue !== undefined && !isFiniteNumber(value.stepValue)) {
        return false;
    }
    if (value.strength !== undefined && !isFiniteNumber(value.strength)) {
        return false;
    }
    if (value.spotlightBlur !== undefined && !isFiniteNumber(value.spotlightBlur)) {
        return false;
    }
    if (value.effectEllipse !== undefined && typeof value.effectEllipse !== "boolean") {
        return false;
    }
    if (value.tail !== undefined && typeof value.tail !== "boolean") {
        return false;
    }
    if (value.points !== undefined && !isPointList(value.points)) {
        return false;
    }
    if (value.src !== undefined && typeof value.src !== "string") {
        return false;
    }
    if (value.srcX !== undefined && !isFiniteNumber(value.srcX)) {
        return false;
    }
    if (value.srcY !== undefined && !isFiniteNumber(value.srcY)) {
        return false;
    }
    if (value.emoji !== undefined && typeof value.emoji !== "string") {
        return false;
    }
    if (value.cursorType !== undefined && (typeof value.cursorType !== "string" || !CURSOR_TYPE_VALUES.has(value.cursorType))) {
        return false;
    }
    return true;
}

/** CSS filter function → catalog effect id (legacy `filters` migration). */
const CSS_FILTER_IDS: Record<string, string> = {
    brightness: "brightness",
    contrast: "contrast",
    saturate: "saturation",
    "hue-rotate": "hue",
    grayscale: "grayscale",
    sepia: "sepia",
    invert: "invert",
    blur: "blur",
};

/** Builds a stack entry with a default seed. */
function stackEntry(id: string, seed = 1): AppliedEffect | null {
    return createAppliedEffect(id, seed);
}

/** `custom_filter` is not in the catalog; it only exists for migrated CSS. */
function customFilterEntry(css: string, seed: number): AppliedEffect {
    return { id: "custom_filter", params: { css }, seed };
}

/** Applies a numeric override with schema clamping. */
function setNumber(entry: AppliedEffect, key: string, value: number): void {
    const def = findEffect(entry.id);
    const param = def?.params.find((item) => item.key === key);
    if (!param) {
        return;
    }
    entry.params[key] = normalizeParamValue(param, value) as ParamValue;
}

/** Converts one legacy CSS filter string into zero or more stack entries. */
function migrateCssFilter(value: string, seed: number): AppliedEffect[] {
    const out: AppliedEffect[] = [];
    const pattern = /([a-z-]+)\(\s*([^)]*)\s*\)/gi;
    let match: RegExpExecArray | null;
    let matched = false;
    while ((match = pattern.exec(value)) !== null) {
        matched = true;
        const fn = match[1].toLowerCase();
        const arg = Number.parseFloat(match[2].replace(/px|deg|%|rad/i, ""));
        const id = CSS_FILTER_IDS[fn];
        if (!id) {
            out.push(customFilterEntry(match[0], seed));
            continue;
        }
        const entry = stackEntry(id, seed);
        if (!entry) {
            continue;
        }
        if (Number.isFinite(arg)) {
            if (fn === "brightness" || fn === "contrast" || fn === "saturate") {
                setNumber(entry, "amount", (arg - 1) * 100);
            } else if (fn === "hue-rotate") {
                setNumber(entry, "amount", arg);
            } else if (fn === "grayscale" || fn === "sepia") {
                setNumber(entry, "strength", arg * 100);
            } else if (fn === "blur") {
                setNumber(entry, "radius", Math.max(1, arg));
            }
        }
        out.push(entry);
    }
    if (!matched && value.trim()) {
        out.push(customFilterEntry(value.trim(), seed));
    }
    return out;
}

/** Converts one legacy decoration into an equivalent stack entry. */
function migrateDecoration(decoration: Decoration): AppliedEffect | null {
    if (decoration.kind === "snow") {
        return stackEntry("snowflakes", decoration.seed);
    }
    if (decoration.kind === "confetti") {
        return stackEntry("confetti", decoration.seed);
    }
    if (decoration.kind === "sparkle") {
        return stackEntry("draw_particles", decoration.seed);
    }
    const entry = stackEntry("add_noise", decoration.seed);
    if (entry) {
        setNumber(entry, "amount", 12);
    }
    return entry;
}

/**
 * Validates and migrates the effect state.
 *
 * Accepts the v2 `stack` shape; legacy `filters` / `decorations` are converted
 * to equivalent stack entries. Unknown CSS filters survive as `custom_filter`.
 */
export function migrateEffectState(value: unknown): EffectState | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        !isFiniteNumber(value.rotate) ||
        !isFiniteNumber(value.flipX) ||
        !isFiniteNumber(value.flipY)
    ) {
        return null;
    }
    const base = {
        rotate: value.rotate,
        flipX: value.flipX,
        flipY: value.flipY,
    };

    if (Array.isArray(value.stack)) {
        const stack: AppliedEffect[] = [];
        for (const item of value.stack) {
            const entry = sanitizeAppliedEffect(item);
            if (entry) {
                stack.push(entry);
            }
        }
        return { stack, ...base };
    }

    const rawFilters = value.filters;
    if (
        rawFilters !== undefined &&
        (!Array.isArray(rawFilters) ||
            rawFilters.some((filter) => typeof filter !== "string"))
    ) {
        return null;
    }
    const stack: AppliedEffect[] = [];
    let seed = 1;
    for (const filter of (rawFilters ?? []) as string[]) {
        stack.push(...migrateCssFilter(filter, seed++));
    }
    if (Array.isArray(value.decorations)) {
        for (const decoration of value.decorations) {
            if (!isRecord(decoration) || typeof decoration.kind !== "string") {
                continue;
            }
            const entry = migrateDecoration({
                kind: decoration.kind as Decoration["kind"],
                seed: isFiniteNumber(decoration.seed) ? decoration.seed : seed++,
            });
            if (entry) {
                stack.push(entry);
            }
        }
    }
    return { stack, ...base };
}

/** Structural validation for the background state. */
function isBgState(value: unknown): value is BgState {
    if (!isRecord(value)) {
        return false;
    }
    return (
        isFiniteNumber(value.margin) &&
        isFiniteNumber(value.padding) &&
        typeof value.smartPadding === "boolean" &&
        isFiniteNumber(value.corner) &&
        isFiniteNumber(value.shadow) &&
        typeof value.ratio === "string" &&
        typeof value.mode === "string" &&
        BG_MODE_VALUES.has(value.mode) &&
        isFiniteNumber(value.gradient) &&
        typeof value.gradientFrom === "string" &&
        typeof value.gradientTo === "string" &&
        typeof value.solid === "string" &&
        typeof value.imageSrc === "string"
    );
}

/** Structural validation for a legacy v1 annotation. */
function isV1Annotation(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.id !== "string") {
        return false;
    }
    if (typeof value.type !== "string" || !V1_ANNOTATION_TYPES.has(value.type)) {
        return false;
    }
    if (typeof value.color !== "string") {
        return false;
    }
    if (
        !isFiniteNumber(value.width) ||
        !isFiniteNumber(value.x1) ||
        !isFiniteNumber(value.y1) ||
        !isFiniteNumber(value.x2) ||
        !isFiniteNumber(value.y2)
    ) {
        return false;
    }
    if (value.fontSize !== undefined && (!isFiniteNumber(value.fontSize) || value.fontSize <= 0)) {
        return false;
    }
    if (value.text !== undefined && typeof value.text !== "string") {
        return false;
    }
    return true;
}

/** Converts a validated v1 annotation into a v2 annotation with default styling. */
function upgradeAnnotation(value: Record<string, unknown>): Annotation {
    const legacyType = value.type as "rect" | "arrow" | "text";
    const color = value.color as string;
    const base = {
        id: value.id as string,
        stroke: color,
        fill: "transparent",
        width: value.width as number,
        borderStyle: "solid" as const,
        corner: 0,
        shadow: { ...DEFAULT_SHADOW },
        x1: value.x1 as number,
        y1: value.y1 as number,
        x2: value.x2 as number,
        y2: value.y2 as number,
    };

    if (legacyType === "text") {
        return {
            ...base,
            type: "text",
            ...(value.text !== undefined ? { text: value.text as string } : {}),
            ...(value.fontSize !== undefined ? { fontSize: value.fontSize as number } : {}),
            textColor: color,
            fontFamily: "Segoe UI",
            align: "left",
            bold: false,
            italic: false,
        };
    }

    return {
        ...base,
        type: legacyType === "rect" ? "rectangle" : "arrow",
    } as Annotation;
}

/** Optional v1/v2 project fields, validated but not required. */
function isValidOptionalFields(meta: Record<string, unknown>): boolean {
    if (meta.originalFileName !== undefined && typeof meta.originalFileName !== "string") {
        return false;
    }
    if (meta.originalHash !== undefined && typeof meta.originalHash !== "string") {
        return false;
    }
    if (meta.savedAt !== undefined && !isFiniteNumber(meta.savedAt)) {
        return false;
    }
    return true;
}

/** Result of decoding a tEXt payload, including whether a v1 upgrade happened. */
export interface DecodedProjectMeta {
    meta: ProjectMetaV2;
    upgraded: boolean;
}

/** Shared v2/v1 decoding pipeline; null whenever the payload cannot be trusted. */
function decodeMetaDetailed(value: string): DecodedProjectMeta | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeURIComponent(value));
    } catch {
        return null;
    }
    if (!isRecord(parsed) || parsed.plugin !== "anno-mark") {
        return null;
    }

    if (parsed.v === 2) {
        if (!Array.isArray(parsed.annotations)) {
            return null;
        }
        for (const annotation of parsed.annotations) {
            if (!isAnnotation(annotation)) {
                return null;
            }
        }
        let effects: EffectState;
        if (parsed.effects === undefined) {
            effects = { ...DEFAULT_EFFECTS, stack: [] };
        } else {
            const migrated = migrateEffectState(parsed.effects);
            if (!migrated) {
                return null;
            }
            effects = migrated;
        }
        let bg: BgState;
        if (parsed.bg === undefined) {
            bg = { ...DEFAULT_BG };
        } else if (isBgState(parsed.bg)) {
            bg = parsed.bg;
        } else {
            return null;
        }
        if (!isValidOptionalFields(parsed)) {
            return null;
        }
        const meta: ProjectMetaV2 = {
            v: 2,
            plugin: "anno-mark",
            annotations: parsed.annotations,
            effects,
            bg,
            ...(parsed.originalFileName !== undefined
                ? { originalFileName: parsed.originalFileName as string }
                : {}),
            ...(parsed.originalHash !== undefined
                ? { originalHash: parsed.originalHash as string }
                : {}),
            ...(parsed.savedAt !== undefined ? { savedAt: parsed.savedAt as number } : {}),
        };
        return { meta, upgraded: false };
    }

    if (parsed.v === 1) {
        if (!Array.isArray(parsed.annotations)) {
            return null;
        }
        for (const annotation of parsed.annotations) {
            if (!isV1Annotation(annotation)) {
                return null;
            }
        }
        if (!isValidOptionalFields(parsed)) {
            return null;
        }
        const annotations = parsed.annotations.map((annotation) =>
            upgradeAnnotation(annotation as Record<string, unknown>)
        );
        const meta: ProjectMetaV2 = {
            v: 2,
            plugin: "anno-mark",
            annotations,
            effects: { ...DEFAULT_EFFECTS, stack: [] },
            bg: { ...DEFAULT_BG },
            ...(parsed.originalFileName !== undefined
                ? { originalFileName: parsed.originalFileName as string }
                : {}),
            ...(parsed.originalHash !== undefined
                ? { originalHash: parsed.originalHash as string }
                : {}),
            ...(parsed.savedAt !== undefined ? { savedAt: parsed.savedAt as number } : {}),
        };
        return { meta, upgraded: true };
    }

    // Unknown version (including missing/non-numeric) is not editable.
    return null;
}

/**
 * Parses a tEXt value produced by encodeMeta.
 *
 * Supports v2 natively and upgrades v1 projects transparently. Returns null for
 * malformed input (bad URI encoding, bad JSON, unknown version, wrong plugin
 * tag, invalid annotations/effects/background). Never repairs unknown data.
 */
export function decodeMeta(value: string): ProjectMetaV2 | null {
    return decodeMetaDetailed(value)?.meta ?? null;
}

/** Reads and decodes the anno-mark metadata embedded in a PNG; null when absent or invalid. */
export function readProjectMeta(bytes: Uint8Array): ProjectMetaV2 | null {
    const raw = readPngText(bytes, META_KEY);
    if (raw === null) {
        return null;
    }
    return decodeMeta(raw);
}

/**
 * Reads project metadata and reports whether a legacy v1 payload was upgraded.
 * Null when the PNG carries no (or invalid) anno-mark metadata.
 */
export function readProjectMetaWithUpgrade(
    bytes: Uint8Array
): DecodedProjectMeta | null {
    const raw = readPngText(bytes, META_KEY);
    if (raw === null) {
        return null;
    }
    return decodeMetaDetailed(raw);
}

/**
 * SHA-1 of bytes or a UTF-8 encoded string, as lowercase hex.
 *
 * Throws a readable error when WebCrypto's SubtleCrypto is unavailable.
 */
export async function sha1Hex(input: Uint8Array | string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error("SHA-1 is unavailable: crypto.subtle is not supported in this environment");
    }
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    // Copy into a plain ArrayBuffer-backed view so the input may be any Uint8Array.
    const data = new Uint8Array(bytes.length);
    data.set(bytes);
    const digest = await subtle.digest("SHA-1", data);
    const view = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < view.length; i++) {
        hex += view[i].toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Cache path (relative to the SiYuan data dir) for an original image.
 *
 * `assetPath` is kept for future per-asset layouts; the cache is content
 * addressed by hash only.
 */
export function originalCachePath(assetPath: string, hash: string): string {
    void assetPath;
    return `${ORIGINALS_DIR}/${hash}.png`;
}

/** Assembles fresh v2 project metadata; optional fields are omitted when not provided. */
export function buildProjectMeta(
    annotations: Annotation[],
    effects: EffectState,
    bg: BgState,
    originalFileName?: string,
    originalHash?: string
): ProjectMetaV2 {
    return {
        v: 2,
        plugin: "anno-mark",
        annotations,
        effects,
        bg,
        ...(originalFileName !== undefined ? { originalFileName } : {}),
        ...(originalHash !== undefined ? { originalHash } : {}),
        savedAt: Date.now(),
    };
}
