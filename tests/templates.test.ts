import test from "node:test";
import assert from "node:assert/strict";

import {
    BUILTIN_TEMPLATES,
    TEMPLATES_KEY,
    borderStyleCss,
    createTemplate,
    deleteTemplate,
    isStyleTemplate,
    loadTemplates,
    saveTemplates,
    templatePreviewHTML,
} from "../src/ui/templates.ts";
import { TOOL_ORDER, createOptions } from "../src/types.ts";

/** Minimal localStorage stand-in so the storage helpers can be exercised. */
function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() {
            return data.size;
        },
        clear: () => data.clear(),
        getItem: (key: string) => data.get(key) ?? null,
        key: (index: number) => [...data.keys()][index] ?? null,
        removeItem: (key: string) => {
            data.delete(key);
        },
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
    };
}

const storage = memoryStorage();
Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
});

function resetStorage(): void {
    storage.clear();
}

test("built-in templates expose four tools with complete options", () => {
    assert.equal(BUILTIN_TEMPLATES.length, 4);
    assert.deepEqual(
        BUILTIN_TEMPLATES.map((template) => template.tool),
        ["rectangle", "text", "rectangle", "rectangle"]
    );
    const ids = new Set(BUILTIN_TEMPLATES.map((template) => template.id));
    assert.equal(ids.size, 4);

    const optionKeys = Object.keys(createOptions()).sort();
    for (const template of BUILTIN_TEMPLATES) {
        assert.equal(template.builtin, true);
        assert.deepEqual(Object.keys(template.opts).sort(), optionKeys);
        assert.equal(typeof template.opts.shadow.enabled, "boolean");
        assert.ok(TOOL_ORDER.includes(template.tool));
    }
});

test("preview markup follows the tool and renders dash styles", () => {
    assert.equal(borderStyleCss("dash"), "dashed");
    assert.equal(borderStyleCss("dot"), "dotted");
    assert.equal(borderStyleCss("dashdot"), "dashed");
    assert.equal(borderStyleCss("solid"), "solid");

    const text = BUILTIN_TEMPLATES.find((item) => item.tool === "text");
    assert.ok(text);
    assert.match(templatePreviewHTML(text), /Aa/);

    const dashed = BUILTIN_TEMPLATES.find(
        (item) => item.opts.borderStyle === "dash"
    );
    assert.ok(dashed);
    assert.match(templatePreviewHTML(dashed), /border:2px dashed/);

    const line = createTemplate("line", "line", {
        ...createOptions(),
        borderStyle: "dot",
    });
    assert.match(templatePreviewHTML(line), /stroke-dasharray="2 4"/);

    const ellipse = createTemplate("ellipse", "ellipse", createOptions());
    assert.match(templatePreviewHTML(ellipse), /is-ellipse/);

    const step = createTemplate("step", "step", createOptions());
    assert.match(templatePreviewHTML(step), /am-tpl-step/);
});

test("createTemplate trims names, keeps tools and isolates options", () => {
    const source = createOptions();
    const existing = BUILTIN_TEMPLATES.slice();
    const first = createTemplate("  Focus ring  ", "arrow", source, existing);
    const second = createTemplate("Focus ring", "arrow", source, [...existing, first]);

    assert.equal(first.name, "Focus ring");
    assert.equal(first.tool, "arrow");
    assert.equal(first.builtin, false);
    assert.notEqual(first.id, second.id);

    source.stroke = "#000000";
    source.shadow.blur = 99;
    assert.notEqual(first.opts.stroke, "#000000");
    assert.notEqual(first.opts.shadow.blur, 99);
});

test("saving strips built-ins and loading returns independent copies", () => {
    resetStorage();
    const custom = createTemplate("Blue", "rectangle", {
        ...createOptions(),
        stroke: "#3E83F2",
    });
    saveTemplates([...BUILTIN_TEMPLATES, custom]);

    const stored: unknown = JSON.parse(storage.getItem(TEMPLATES_KEY) ?? "[]");
    assert.ok(Array.isArray(stored));
    assert.equal(stored.length, 1);

    const loaded = loadTemplates();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, custom.id);
    assert.equal(loaded[0].builtin, false);

    loaded[0].opts.shadow.blur = 42;
    const again = loadTemplates();
    assert.notEqual(again[0].opts.shadow.blur, 42);
});

test("malformed and duplicate persisted entries are filtered out", () => {
    resetStorage();
    const valid = createTemplate("Valid", "rectangle", createOptions());
    storage.setItem(
        TEMPLATES_KEY,
        JSON.stringify([
            valid,
            { ...valid },
            { id: "", name: "No id", tool: "rectangle", opts: createOptions() },
            { id: "x", name: "Wrong tool", tool: "nope", opts: createOptions() },
            { id: "y", name: "No opts", tool: "rectangle" },
            { id: "z", name: "Builtin in custom", tool: "text", opts: createOptions(), builtin: true },
            "not an object",
            null,
        ])
    );

    const loaded = loadTemplates();
    assert.deepEqual(
        loaded.map((template) => template.id),
        [valid.id]
    );
    assert.equal(isStyleTemplate({ ...valid, builtin: true }), false);
    assert.equal(isStyleTemplate(valid), true);
});

test("deleteTemplate removes one custom template and persists the rest", () => {
    resetStorage();
    const keep = createTemplate("Keep", "rectangle", createOptions());
    const drop = createTemplate("Drop", "text", createOptions());
    saveTemplates([keep, drop]);

    const rest = deleteTemplate(drop.id);
    assert.deepEqual(
        rest.map((template) => template.id),
        [keep.id]
    );
    assert.deepEqual(
        loadTemplates().map((template) => template.id),
        [keep.id]
    );
});
