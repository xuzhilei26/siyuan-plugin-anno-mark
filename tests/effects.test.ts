import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    EFFECT_CATALOG,
    EFFECT_CATEGORIES,
    categoryCounts,
    createAppliedEffect,
    defaultParams,
    findEffect,
    hasParams,
    normalizeParamValue,
    sanitizeAppliedEffect,
} from "../src/effects/catalog.ts";
import { EFFECT_IMPLS, FRAME_EFFECTS } from "../src/effects/impl/index.ts";
import { RAW_EFFECTS } from "../src/effects/data/effects.ts";
import { migrateEffectState } from "../src/storage.ts";

/** ShareX 3.x snapshot extracted from ShareX.ImageEditor source. */
const FIXTURE = JSON.parse(
    readFileSync(new URL("./fixtures/sharex-effects.json", import.meta.url), "utf8")
) as Array<{
    id: string;
    name: string;
    category: "manipulations" | "adjustments" | "filters" | "drawings";
    tier: "A" | "B" | "C";
    params: Array<{ key: string; type: string; default: unknown }>;
}>;

test("catalog exposes all 232 effects with the ShareX category split", () => {
    assert.equal(EFFECT_CATALOG.length, 232);
    assert.deepEqual(categoryCounts(), {
        manipulation: 34,
        adjustment: 32,
        filter: 153,
        drawing: 13,
    });
    assert.deepEqual(
        EFFECT_CATEGORIES.map((entry) => entry.id),
        ["manipulation", "adjustment", "filter", "drawing"]
    );
});

test("effect ids are unique and match the fixture snapshot", () => {
    const ids = new Set(EFFECT_CATALOG.map((def) => def.id));
    assert.equal(ids.size, EFFECT_CATALOG.length);
    assert.deepEqual([...ids].sort(), FIXTURE.map((item) => item.id).sort());
    assert.equal(RAW_EFFECTS.length, 232);
});

test("tier split stays A=103 / B=110 / C=19", () => {
    const counts = { A: 0, B: 0, C: 0 };
    for (const def of EFFECT_CATALOG) {
        counts[def.tier] += 1;
    }
    assert.deepEqual(counts, { A: 103, B: 110, C: 19 });
});

test("every non-delegated effect has a native implementation", () => {
    for (const def of EFFECT_CATALOG) {
        if (def.delegate) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(EFFECT_IMPLS, def.id),
                false,
                `${def.id} is delegated and must not have a pixel impl`
            );
            continue;
        }
        assert.ok(
            Object.prototype.hasOwnProperty.call(EFFECT_IMPLS, def.id),
            `${def.id} has no implementation`
        );
    }
    for (const id of Object.keys(EFFECT_IMPLS)) {
        assert.ok(findEffect(id), `impl "${id}" is not in the catalog`);
    }
    assert.equal(new Set(EFFECT_CATALOG.map((d) => d.delegate).filter(Boolean)).size, 19);
});

test("frame effects are a subset of the catalog and carry padding", () => {
    assert.equal(FRAME_EFFECTS.size, 30);
    for (const id of FRAME_EFFECTS) {
        assert.ok(findEffect(id), `frame effect "${id}" is not in the catalog`);
        assert.ok(
            Object.prototype.hasOwnProperty.call(EFFECT_IMPLS, id),
            `frame effect "${id}" has no implementation`
        );
    }
});

test("parameter defaults respect the declared schema", () => {
    for (const def of EFFECT_CATALOG) {
        for (const param of def.params) {
            if (param.type === "number") {
                assert.equal(typeof param.default, "number", `${def.id}.${param.key}`);
                assert.ok(Number.isFinite(param.default as number));
                if (typeof param.min === "number") {
                    assert.ok((param.default as number) >= param.min, `${def.id}.${param.key} < min`);
                }
                if (typeof param.max === "number") {
                    assert.ok((param.default as number) <= param.max, `${def.id}.${param.key} > max`);
                }
                if (param.integer) {
                    assert.ok(Number.isInteger(param.default), `${def.id}.${param.key} not integer`);
                }
            } else if (param.type === "enum") {
                const options = param.options ?? [];
                assert.ok(options.length > 0, `${def.id}.${param.key} has no options`);
                assert.ok(
                    options.some((option) => option.value === param.default),
                    `${def.id}.${param.key} default not in options`
                );
            } else if (param.type === "bool") {
                assert.equal(typeof param.default, "boolean");
            } else if (param.type === "color") {
                assert.match(String(param.default), /^#[0-9a-fA-F]{3,8}$/);
            }
        }
    }
});

test("the fixture parameter defaults match the runtime catalog", () => {
    for (const item of FIXTURE) {
        const def = findEffect(item.id);
        assert.ok(def, `missing ${item.id}`);
        assert.deepEqual(
            def.params.map((param) => ({ key: param.key, type: param.type, default: param.default })),
            item.params.map((param) => ({ key: param.key, type: param.type, default: param.default })),
            `${item.id} params drifted`
        );
    }
});

test("hasParams reports the 13 parameterless entries", () => {
    const without = EFFECT_CATALOG.filter((def) => !hasParams(def));
    assert.equal(without.length, 13);
    for (const def of without) {
        const entry = createAppliedEffect(def.id, 3);
        assert.deepEqual(entry, { id: def.id, params: {}, seed: 3 });
    }
});

test("defaultParams and createAppliedEffect fill every key", () => {
    const def = findEffect("color_matrix");
    assert.ok(def);
    const params = defaultParams(def);
    assert.equal(Object.keys(params).length, def.params.length);
    const entry = createAppliedEffect("color_matrix", 7);
    assert.ok(entry);
    assert.equal(entry.seed, 7);
    assert.deepEqual(entry.params, params);
    assert.equal(createAppliedEffect("does_not_exist"), null);
});

test("normalizeParamValue clamps numbers and rejects unknown enums/colors", () => {
    assert.equal(
        normalizeParamValue({ key: "radius", label: "Radius", type: "number", default: 15, min: 1, max: 100 }, 500),
        100
    );
    assert.equal(
        normalizeParamValue({ key: "radius", label: "Radius", type: "number", default: 15, min: 1, max: 100, integer: true }, 3.7),
        4
    );
    assert.equal(
        normalizeParamValue({ key: "radius", label: "Radius", type: "number", default: 15 }, "oops"),
        15
    );
    assert.equal(
        normalizeParamValue(
            { key: "mode", label: "Mode", type: "enum", default: "A", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
            "Z"
        ),
        "A"
    );
    assert.equal(
        normalizeParamValue({ key: "color", label: "Color", type: "color", default: "#000000" }, "red"),
        "#000000"
    );
    assert.equal(
        normalizeParamValue({ key: "text", label: "Text", type: "text", default: "hi" }, 42),
        "42"
    );
});

test("sanitizeAppliedEffect repairs unknown params and keeps unknown ids", () => {
    const blur = sanitizeAppliedEffect({
        id: "gaussian_blur",
        params: { radius: 9999, quality: 3 },
        seed: 4.8,
    });
    assert.deepEqual(blur, { id: "gaussian_blur", params: { radius: 200 }, seed: 4 });

    const unknown = sanitizeAppliedEffect({
        id: "future_effect",
        params: { amount: 2, flag: true, name: "x", nested: { a: 1 } },
    });
    assert.deepEqual(unknown, { id: "future_effect", params: { amount: 2, flag: true, name: "x" }, seed: 1 });

    assert.equal(sanitizeAppliedEffect(null), null);
    assert.equal(sanitizeAppliedEffect({ id: "" }), null);
    assert.equal(sanitizeAppliedEffect({ params: {} }), null);
});

test("legacy CSS filters migrate into stack entries", () => {
    const migrated = migrateEffectState({
        filters: ["brightness(1.16) contrast(1.2) blur(3px) mystery(4)"],
        rotate: 0,
        flipX: 1,
        flipY: 1,
    });
    assert.ok(migrated);
    assert.equal(migrated.rotate, 0);
    const ids = migrated.stack.map((item) => item.id);
    assert.deepEqual(ids, ["brightness", "contrast", "blur", "custom_filter"]);
    assert.equal(migrated.stack[0].params.amount, (1.16 - 1) * 100);
    assert.equal(migrated.stack[2].params.radius, 3);
    assert.equal(migrated.stack[3].params.css, "mystery(4)");
});

test("legacy decorations migrate to seeded stack entries", () => {
    const migrated = migrateEffectState({
        decorations: [
            { kind: "snow", seed: 11 },
            { kind: "confetti", seed: 12 },
            { kind: "sparkle", seed: 13 },
            { kind: "noise", seed: 14 },
        ],
        rotate: 90,
        flipX: -1,
        flipY: 1,
    });
    assert.ok(migrated);
    assert.deepEqual(
        migrated.stack.map((item) => [item.id, item.seed]),
        [
            ["snowflakes", 11],
            ["confetti", 12],
            ["draw_particles", 13],
            ["add_noise", 14],
        ]
    );
    assert.equal(migrated.stack[3].params.amount, 12);
    assert.equal(migrated.rotate, 90);
    assert.equal(migrated.flipX, -1);
});

test("migrateEffectState prefers an explicit stack and rejects broken transforms", () => {
    const migrated = migrateEffectState({
        stack: [{ id: "invert", params: {}, seed: 2 }],
        filters: ["brightness(2)"],
        rotate: 180,
        flipX: 1,
        flipY: -1,
    });
    assert.ok(migrated);
    assert.deepEqual(migrated.stack.map((item) => item.id), ["invert"]);

    assert.equal(migrateEffectState(null), null);
    assert.equal(migrateEffectState({ stack: [], rotate: "x", flipX: 1, flipY: 1 }), null);
});
