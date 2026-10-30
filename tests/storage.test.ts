import test from "node:test";
import assert from "node:assert/strict";

import {
    buildProjectMeta,
    decodeMeta,
    encodeMeta,
    originalCachePath,
    readPngText,
    readProjectMeta,
    readProjectMetaWithUpgrade,
    sha1Hex,
    writePngText,
} from "../src/storage.ts";
import { DEFAULT_BG, DEFAULT_EFFECTS, META_KEY, ORIGINALS_DIR } from "../src/types.ts";
import type { Annotation, EffectState } from "../src/types.ts";

/** 1x1 transparent PNG, used as the base image for every round trip. */
const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PNG = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

/** Default shadow shared by the fixtures (mirrors createOptions). */
const SHADOW = { enabled: false, color: "#000000", blur: 12, opacity: 0.5, x: 4, y: 4 };

/** Common annotation fields; spread into each fixture annotation. */
const BASE = {
    stroke: "#F03E3E",
    fill: "transparent",
    width: 4,
    borderStyle: "solid" as const,
    corner: 0,
    shadow: SHADOW,
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 1,
};

const TOOLS: Annotation[] = [
    { ...BASE, id: "rect-1", type: "rectangle", stroke: "#ff3b30", width: 3, x1: 10, y1: 20, x2: 110, y2: 80 },
    { ...BASE, id: "arrow-1", type: "arrow", stroke: "#0a84ff", width: 2, x1: 5, y1: 6, x2: 300, y2: 400 },
    {
        ...BASE,
        id: "text-1",
        type: "text",
        stroke: "#34c759",
        width: 1,
        x1: 30,
        y1: 40,
        x2: 30,
        y2: 40,
        text: "中文标注：这里有问题",
        fontSize: 18,
        textColor: "#34c759",
        fontFamily: "Segoe UI",
        align: "left",
        bold: true,
        italic: false,
    },
];

interface ParsedChunk {
    type: string;
    data: Uint8Array;
    crcOk: boolean;
}

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

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
    return (
        ((bytes[offset] << 24) |
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3]) >>> 0
    );
}

/** Independent chunk parser used to verify byte layout and CRCs. */
function parseChunks(bytes: Uint8Array): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    let offset = 8;
    while (offset < bytes.length) {
        const length = readU32(bytes, offset);
        const typeStart = offset + 4;
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        assert.ok(dataEnd + 4 <= bytes.length, "chunk overruns buffer");
        const type = Buffer.from(bytes.subarray(typeStart, dataStart)).toString("latin1");
        const stored = readU32(bytes, dataEnd);
        const computed = crc32(bytes.subarray(typeStart, dataEnd));
        chunks.push({ type, data: bytes.subarray(dataStart, dataEnd), crcOk: stored === computed });
        offset = dataEnd + 4;
        if (type === "IEND") {
            break;
        }
    }
    return chunks;
}

function nonTextChunks(bytes: Uint8Array): string[] {
    return parseChunks(bytes)
        .filter((chunk) => chunk.type !== "tEXt")
        .map((chunk) => `${chunk.type}:${Buffer.from(chunk.data).toString("hex")}`);
}

/** Wraps any payload object into the percent-encoded tEXt value. */
function encodeRaw(value: unknown): string {
    return encodeURIComponent(JSON.stringify(value));
}

/** Minimal v1 annotation builder for legacy payloads. */
function v1Annotation(patch: Record<string, unknown>): Record<string, unknown> {
    return {
        id: "a1",
        type: "rect",
        color: "#ff3b30",
        width: 1,
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        ...patch,
    };
}

test("writes and reads back all three annotation tools including Chinese text", () => {
    const meta = buildProjectMeta(TOOLS, DEFAULT_EFFECTS, DEFAULT_BG, "photo.png", "abc123def456");
    const value = encodeMeta(meta);

    // tEXt payload must stay ASCII-only.
    assert.match(value, /^[\x20-\x7e]*$/);

    const written = writePngText(PNG, META_KEY, value);
    const raw = readPngText(written, META_KEY);
    assert.notEqual(raw, null);
    assert.equal(raw, value);

    const decoded = decodeMeta(raw as string);
    assert.notEqual(decoded, null);
    const project = decoded as NonNullable<typeof decoded>;
    assert.equal(project.v, 2);
    assert.equal(project.plugin, "anno-mark");
    assert.equal(project.originalFileName, "photo.png");
    assert.equal(project.originalHash, "abc123def456");
    assert.deepEqual(project.annotations, TOOLS);
    assert.deepEqual(project.effects, DEFAULT_EFFECTS);
    assert.deepEqual(project.bg, DEFAULT_BG);

    // readProjectMeta performs both steps.
    assert.deepEqual(readProjectMeta(written), project);

    // A v2 payload is reported as already up to date.
    const upgradedRead = readProjectMetaWithUpgrade(written);
    assert.notEqual(upgradedRead, null);
    assert.equal(upgradedRead?.upgraded, false);
    assert.deepEqual(upgradedRead?.meta, project);
});

test("rejects non-PNG input without throwing on read", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

    assert.equal(readPngText(jpeg, META_KEY), null);
    assert.equal(readProjectMeta(jpeg), null);
    assert.equal(readProjectMetaWithUpgrade(jpeg), null);
    assert.throws(() => writePngText(jpeg, META_KEY, "x"), /Not a PNG file/);
});

test("keeps every non-tEXt chunk byte-identical and adds exactly one chunk", () => {
    const value = encodeMeta(buildProjectMeta(TOOLS, DEFAULT_EFFECTS, DEFAULT_BG, "photo.png"));
    const written = writePngText(PNG, META_KEY, value);

    const before = parseChunks(PNG);
    const after = parseChunks(written);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(nonTextChunks(written), nonTextChunks(PNG));

    // Every chunk, including the inserted one, carries a correct CRC.
    assert.deepEqual(
        after.filter((chunk) => !chunk.crcOk).map((chunk) => chunk.type),
        []
    );

    // The new tEXt chunk sits directly after IHDR.
    assert.equal(after[0].type, "IHDR");
    assert.equal(after[1].type, "tEXt");
    assert.equal(after[2].type, before[1].type);
});

test("writing the same keyword twice keeps a single chunk with the latest value", () => {
    const first = writePngText(
        PNG,
        META_KEY,
        encodeMeta(buildProjectMeta(TOOLS.slice(0, 1), DEFAULT_EFFECTS, DEFAULT_BG, "a.png"))
    );
    const second = writePngText(
        first,
        META_KEY,
        encodeMeta(buildProjectMeta(TOOLS.slice(0, 2), DEFAULT_EFFECTS, DEFAULT_BG, "b.png"))
    );

    const textChunks = parseChunks(second).filter((chunk) => chunk.type === "tEXt");
    assert.equal(textChunks.length, 1);
    assert.equal(nonTextChunks(second).length, nonTextChunks(PNG).length);

    const decoded = readProjectMeta(second);
    assert.notEqual(decoded, null);
    assert.equal(decoded?.originalFileName, "b.png");
    assert.equal(decoded?.annotations.length, 2);
    assert.deepEqual(decoded?.annotations, TOOLS.slice(0, 2));
});

test("v2 round trip preserves freehand points, the effect stack and a custom background", () => {
    const stack = [
        { id: "brightness", params: { amount: 16 }, seed: 1 },
        { id: "gaussian_blur", params: { radius: 4 }, seed: 2 },
    ];
    const effects: EffectState = { stack, rotate: 90, flipX: -1, flipY: 1 };
    const bg = { ...DEFAULT_BG, margin: 40, mode: "solid" as const, solid: "#123456" };
    const annotations: Annotation[] = [
        ...TOOLS,
        {
            ...BASE,
            id: "pen-1",
            type: "freehand",
            stroke: "#1971C2",
            width: 6,
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            points: [
                [1, 2],
                [3, 4],
            ],
        },
    ];

    const meta = buildProjectMeta(annotations, effects, bg, "draw.png", "hash-v2");
    const decoded = decodeMeta(encodeMeta(meta));

    assert.notEqual(decoded, null);
    const project = decoded as NonNullable<typeof decoded>;
    assert.equal(project.v, 2);
    assert.equal(project.plugin, "anno-mark");
    assert.equal(project.originalFileName, "draw.png");
    assert.equal(project.originalHash, "hash-v2");
    assert.deepEqual(project.annotations, annotations);
    assert.deepEqual(project.effects, effects);
    assert.deepEqual(project.effects.stack, stack);
    assert.deepEqual(project.bg, bg);
    assert.equal(project.bg.margin, 40);
    assert.equal(project.bg.mode, "solid");
    assert.equal(project.bg.solid, "#123456");

    // Decoding through a real PNG keeps the same values and is not an upgrade.
    const written = writePngText(PNG, META_KEY, encodeMeta(meta));
    const read = readProjectMetaWithUpgrade(written);
    assert.notEqual(read, null);
    assert.equal(read?.upgraded, false);
    assert.deepEqual(read?.meta.annotations, annotations);
    assert.deepEqual(read?.meta.effects, effects);
    assert.deepEqual(read?.meta.bg, bg);
});

test("v1 metadata is upgraded to v2 annotations and reported as upgraded", () => {
    const legacy = {
        v: 1,
        plugin: "anno-mark",
        annotations: [
            v1Annotation({ id: "rect-1", type: "rect", color: "#ff3b30", width: 3, x2: 110, y2: 80 }),
            v1Annotation({ id: "arrow-1", type: "arrow", color: "#0a84ff", width: 2, x1: 5, y1: 6, x2: 300, y2: 400 }),
            v1Annotation({
                id: "text-1",
                type: "text",
                color: "#34c759",
                width: 1,
                x1: 30,
                y1: 40,
                x2: 30,
                y2: 40,
                text: "旧标注",
                fontSize: 18,
            }),
        ],
        originalFileName: "legacy.png",
        originalHash: "legacy-hash",
        savedAt: 1700000000000,
    };

    const written = writePngText(PNG, META_KEY, encodeRaw(legacy));
    const read = readProjectMetaWithUpgrade(written);
    assert.notEqual(read, null);
    assert.equal(read?.upgraded, true);

    const project = read?.meta as NonNullable<typeof read>["meta"];
    assert.equal(project.v, 2);
    assert.equal(project.plugin, "anno-mark");
    assert.equal(project.originalFileName, "legacy.png");
    assert.equal(project.originalHash, "legacy-hash");
    assert.equal(project.savedAt, 1700000000000);
    assert.deepEqual(project.effects, DEFAULT_EFFECTS);
    assert.deepEqual(project.bg, DEFAULT_BG);
    assert.equal(project.bg.margin, 24);

    assert.deepEqual(
        project.annotations.map((annotation) => annotation.type),
        ["rectangle", "arrow", "text"]
    );
    const [rect, arrow, text] = project.annotations;
    assert.equal(rect.stroke, "#ff3b30");
    assert.equal(rect.fill, "transparent");
    assert.equal(rect.width, 3);
    assert.equal(rect.borderStyle, "solid");
    assert.equal(rect.corner, 0);
    assert.deepEqual(rect.shadow, SHADOW);
    assert.equal(arrow.stroke, "#0a84ff");
    assert.equal(text.text, "旧标注");
    assert.equal(text.fontSize, 18);
    assert.equal(text.textColor, "#34c759");
    assert.equal(text.fontFamily, "Segoe UI");
    assert.equal(text.align, "left");
    assert.equal(text.bold, false);
    assert.equal(text.italic, false);

    // readProjectMeta also returns the upgraded payload, without the flag.
    assert.deepEqual(readProjectMeta(written), project);
});

test("decodeMeta returns null for corrupted payloads and unknown versions", () => {
    const badAnnotation = (patch: Record<string, unknown>) =>
        encodeRaw({
            v: 2,
            plugin: "anno-mark",
            annotations: [
                {
                    id: "a1",
                    type: "rectangle",
                    stroke: "#ff3b30",
                    fill: "transparent",
                    width: 1,
                    borderStyle: "solid",
                    corner: 0,
                    shadow: SHADOW,
                    x1: 0,
                    y1: 0,
                    x2: 1,
                    y2: 1,
                    ...patch,
                },
            ],
        });

    const invalidValues = [
        "abc%ZZ", // not valid URI encoding
        "not json at all", // not JSON
        encodeURIComponent("null"), // not an object
        encodeRaw({ v: 1, plugin: "anno-mark" }), // missing annotations
        encodeRaw({ v: 3, plugin: "anno-mark", annotations: [] }), // unknown version
        encodeRaw({ v: "2", plugin: "anno-mark", annotations: [] }), // version type
        encodeRaw({ plugin: "anno-mark", annotations: [] }), // missing version
        encodeRaw({ v: 2, annotations: [] }), // missing plugin
        encodeRaw({ v: 2, plugin: "other", annotations: [] }), // wrong plugin
        encodeRaw({ v: 2, plugin: "anno-mark", annotations: "nope" }), // annotations type
        encodeRaw({ v: 2, plugin: "anno-mark" }),
        encodeRaw({ v: 2, plugin: "anno-mark", annotations: [], effects: { filters: "x" } }),
        encodeRaw({ v: 2, plugin: "anno-mark", annotations: [], bg: { margin: "24" } }),
        encodeRaw({ v: 2, plugin: "anno-mark", annotations: [], savedAt: "now" }),
        badAnnotation({ type: "circle" }),
        badAnnotation({ id: 42 }),
        badAnnotation({ id: undefined }), // annotation without id
        badAnnotation({ stroke: 0xff0000 }),
        badAnnotation({ fill: null }),
        badAnnotation({ borderStyle: "wavy" }),
        badAnnotation({ corner: "0" }),
        badAnnotation({ shadow: { enabled: "no" } }),
        badAnnotation({ x1: "10" }),
        badAnnotation({ width: Number.NaN }),
        badAnnotation({ fontSize: 0 }),
        badAnnotation({ text: 5 }),
        badAnnotation({ align: "justify" }),
        badAnnotation({ points: [[1, "2"]] }),
    ];

    for (const value of invalidValues) {
        assert.equal(decodeMeta(value), null, value);
    }
});

test("sha1Hex hashes UTF-8 strings and bytes to known lowercase hex", async () => {
    const expected = "0f2d3551fc132d0c952782123b0231bceef98a11"; // SHA-1("anno-mark")
    assert.equal(await sha1Hex("anno-mark"), expected);
    assert.match(await sha1Hex("anno-mark"), /^[0-9a-f]{40}$/);
    assert.equal(await sha1Hex(new TextEncoder().encode("anno-mark")), expected);
});

test("originalCachePath and buildProjectMeta follow the agreed shapes", () => {
    assert.equal(originalCachePath("assets/photo.png", "deadbeef"), `${ORIGINALS_DIR}/deadbeef.png`);

    const effects: EffectState = { ...DEFAULT_EFFECTS };
    const meta = buildProjectMeta(TOOLS, effects, DEFAULT_BG);
    assert.deepEqual(
        Object.keys(meta).sort(),
        ["annotations", "bg", "effects", "plugin", "savedAt", "v"]
    );
    assert.equal(typeof meta.savedAt, "number");
    assert.equal(meta.v, 2);
    assert.equal(meta.plugin, "anno-mark");
    assert.deepEqual(meta.annotations, TOOLS);
    assert.deepEqual(meta.effects, effects);
    assert.deepEqual(meta.bg, DEFAULT_BG);
});
