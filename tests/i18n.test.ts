import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RAW_EFFECTS } from "../src/effects/data/effects.ts";

type Dict = Record<string, string>;

function load(name: string): Dict {
    return JSON.parse(
        readFileSync(new URL(`../i18n/${name}.json`, import.meta.url), "utf8")
    ) as Dict;
}

const zh = load("zh_CN");
const en = load("en_US");
const LANGS: Array<[string, Dict]> = [
    ["zh_CN", zh],
    ["en_US", en],
];

/** Every `effect.<id>` key, i.e. a direct child of `effect` with no further dot. */
function effectNameKeys(dict: Dict): string[] {
    return Object.keys(dict).filter((key) => /^effect\.[^.]+$/.test(key));
}

function paramKeys(dict: Dict): string[] {
    return Object.keys(dict).filter((key) => key.startsWith("effect.param."));
}

const RAW_IDS = new Set(RAW_EFFECTS.map((effect) => effect.id));
const ENUM_VALUES = new Set<string>();
for (const effect of RAW_EFFECTS) {
    for (const param of effect.params) {
        for (const option of param.options ?? []) {
            ENUM_VALUES.add(option.value);
        }
    }
}

test("both dictionaries expose the same key set", () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test("all 232 catalog effects are translated in both languages", () => {
    assert.equal(RAW_EFFECTS.length, 232);
    for (const [lang, dict] of LANGS) {
        for (const effect of RAW_EFFECTS) {
            const key = `effect.${effect.id}`;
            assert.equal(typeof dict[key], "string", `${lang} missing ${key}`);
            assert.ok(dict[key].trim() !== "", `${lang} has empty ${key}`);
        }
    }
    for (const [lang, dict] of LANGS) {
        assert.equal(effectNameKeys(dict).length, 232, `${lang} effect name count`);
    }
});

test("effect param dictionaries match across languages", () => {
    const zhKeys = paramKeys(zh);
    const enKeys = paramKeys(en);
    assert.ok(zhKeys.length > 0);
    assert.deepEqual(zhKeys.sort(), enKeys.sort());
    for (const [lang, dict] of LANGS) {
        for (const key of paramKeys(dict)) {
            assert.ok(dict[key].trim() !== "", `${lang} has empty ${key}`);
        }
    }
});

test("all 74 enum options are translated in both languages", () => {
    assert.equal(ENUM_VALUES.size, 74);
    for (const [lang, dict] of LANGS) {
        for (const value of ENUM_VALUES) {
            const key = `effect.enum.${value}`;
            assert.equal(typeof dict[key], "string", `${lang} missing ${key}`);
            assert.ok(dict[key].trim() !== "", `${lang} has empty ${key}`);
        }
    }
});

test("obsolete category keys are gone", () => {
    const obsolete = [
        "effects.cat.action",
        "effects.cat.adjust",
        "effects.cat.draw",
        "effects.hint.action",
        "effects.hint.adjust",
        "effects.hint.draw",
    ];
    for (const [lang, dict] of LANGS) {
        for (const key of obsolete) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(dict, key),
                false,
                `${lang} still has ${key}`
            );
        }
    }
});

test("no effect name key points at an unknown catalog id", () => {
    for (const [lang, dict] of LANGS) {
        for (const key of effectNameKeys(dict)) {
            const id = key.slice("effect.".length);
            assert.ok(RAW_IDS.has(id), `${lang} has unknown effect id "${id}"`);
        }
    }
});
