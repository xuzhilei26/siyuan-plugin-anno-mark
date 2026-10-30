/**
 * Left sidebar: saved style templates.
 *
 * Owns no template state. Saving, applying and deleting are delegated to the
 * editor; `sync` only rebuilds the two template groups from the list it is
 * given, preserving the caller's order and the current search text.
 */
import "./templates-panel.css";
import type { StyleTemplate, TFn } from "../types.ts";
import { getIcon } from "./icons.ts";
import { templatePreviewHTML } from "./templates.ts";

export interface TemplatesPanelOptions {
    t: TFn;
    onSave(name: string): void;
    onApply(template: StyleTemplate): void;
    onDelete(id: string): void;
}

export interface TemplatesPanelApi {
    element: HTMLElement;
    sync(list: StyleTemplate[]): void;
    destroy(): void;
}

type Cleanup = () => void;

export function mountTemplatesPanel(
    container: HTMLElement,
    options: TemplatesPanelOptions
): TemplatesPanelApi {
    const { t } = options;
    const cleanups: Cleanup[] = [];
    let cardCleanups: Cleanup[] = [];
    let items: StyleTemplate[] = [];
    let snapshot = "";
    let destroyed = false;

    const element = document.createElement("div");
    element.className = "am-panel am-tpl-panel";

    /** `t` returns the key when missing, so every call supplies a fallback. */
    function tr(
        key: string,
        fallback: string,
        vars?: Record<string, string | number>
    ): string {
        const text = t(key, vars);
        if (text !== key) {
            return text;
        }
        if (!vars) {
            return fallback;
        }
        return fallback.replace(/\{(\w+)\}/g, (match, name: string) => {
            const value = vars[name];
            return value === undefined ? match : String(value);
        });
    }

    function bind(
        target: EventTarget,
        type: string,
        handler: (event: Event) => void,
        bucket: Cleanup[] = cleanups
    ): void {
        target.addEventListener(type, handler);
        bucket.push(() => target.removeEventListener(type, handler));
    }

    // ---- Header ------------------------------------------------------------
    const title = document.createElement("h3");
    title.className = "am-panel-title";
    title.innerHTML = getIcon("bookmark");
    const titleText = document.createElement("span");
    titleText.textContent = tr("tpl.title", "Style templates");
    title.appendChild(titleText);
    element.appendChild(title);

    // ---- Save --------------------------------------------------------------
    const saveRow = document.createElement("div");
    saveRow.className = "am-tpl-save";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "am-tpl-name";
    nameInput.maxLength = 60;
    const namePlaceholder = tr("tpl.namePlaceholder", "Name this style");
    nameInput.placeholder = namePlaceholder;
    nameInput.setAttribute("aria-label", namePlaceholder);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "am-tpl-save-btn";
    saveBtn.textContent = tr("tpl.save", "Save");

    saveRow.append(nameInput, saveBtn);
    element.appendChild(saveRow);

    // ---- Search ------------------------------------------------------------
    const search = document.createElement("div");
    search.className = "am-search";
    search.innerHTML = getIcon("search");
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    const searchPlaceholder = tr("tpl.search", "Search templates");
    searchInput.placeholder = searchPlaceholder;
    searchInput.setAttribute("aria-label", searchPlaceholder);
    search.appendChild(searchInput);
    element.appendChild(search);

    // ---- Groups ------------------------------------------------------------
    const listRoot = document.createElement("div");
    listRoot.className = "am-tpl-list";

    function createGroup(kind: "mine" | "builtin"): {
        root: HTMLDivElement;
        head: HTMLDivElement;
        grid: HTMLDivElement;
    } {
        const root = document.createElement("div");
        root.className = "am-tpl-group";
        root.dataset.group = kind;

        const head = document.createElement("div");
        head.className = "am-tpl-group-head";

        const grid = document.createElement("div");
        grid.className = "am-tpl-grid";

        root.append(head, grid);
        return { root, head, grid };
    }

    const mineGroup = createGroup("mine");
    const builtinGroup = createGroup("builtin");
    listRoot.append(mineGroup.root, builtinGroup.root);

    const empty = document.createElement("div");
    empty.className = "am-tpl-empty";
    empty.hidden = true;

    element.append(listRoot, empty);

    // ---- Helpers -----------------------------------------------------------
    function builtinName(template: StyleTemplate): string {
        if (template.builtin !== true) {
            return template.name;
        }
        const key = `tpl.builtinName.${template.id.replace(/^builtin-/, "")}`;
        const text = t(key);
        return text === key ? template.name : text;
    }

    function toolLabel(template: StyleTemplate): string {
        return tr(`tool.${template.tool}`, template.tool);
    }

    function matches(template: StyleTemplate, query: string): boolean {
        if (query === "") {
            return true;
        }
        const name = builtinName(template).toLowerCase();
        const tool = toolLabel(template).toLowerCase();
        const stroke = String(template.opts.stroke).toLowerCase();
        const textColor = String(template.opts.textColor).toLowerCase();
        return (
            name.includes(query) ||
            tool.includes(query) ||
            stroke.includes(query) ||
            textColor.includes(query)
        );
    }

    function buildCard(template: StyleTemplate): HTMLElement {
        const card = document.createElement("div");
        card.className = "am-tpl-card";
        card.dataset.id = template.id;
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        const label = builtinName(template);
        const tool = toolLabel(template);
        card.title = `${label} · ${tool}`;
        card.setAttribute("aria-label", `${label} · ${tool}`);

        const swatch = document.createElement("span");
        swatch.className = "am-tpl-swatch";
        swatch.innerHTML = templatePreviewHTML(template);

        const main = document.createElement("span");
        main.className = "am-tpl-main";

        const name = document.createElement("span");
        name.className = "am-tpl-name";
        name.textContent = label;

        const toolRow = document.createElement("span");
        toolRow.className = "am-tpl-tool";
        const icon = document.createElement("span");
        icon.className = "am-tpl-tool-icon";
        icon.innerHTML = getIcon(template.tool);
        const toolText = document.createElement("span");
        toolText.textContent = tool;
        toolRow.append(icon, toolText);

        main.append(name, toolRow);
        card.append(swatch, main);

        if (template.builtin === true) {
            const badge = document.createElement("span");
            badge.className = "am-tpl-badge";
            badge.textContent = tr("tpl.badge", "Built-in");
            card.appendChild(badge);
        } else {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "am-tpl-del";
            del.title = tr("tpl.delete", "Delete");
            del.setAttribute("aria-label", del.title);
            del.innerHTML = getIcon("trash");
            bind(
                del,
                "click",
                (event) => {
                    event.stopPropagation();
                    options.onDelete(template.id);
                },
                cardCleanups
            );
            bind(
                del,
                "keydown",
                (event) => event.stopPropagation(),
                cardCleanups
            );
            card.appendChild(del);
        }

        bind(card, "click", () => options.onApply(template), cardCleanups);
        bind(
            card,
            "keydown",
            (event) => {
                const key = (event as KeyboardEvent).key;
                if (key === "Enter" || key === " ") {
                    event.preventDefault();
                    options.onApply(template);
                }
            },
            cardCleanups
        );
        return card;
    }

    function fillGroup(
        group: { root: HTMLDivElement; head: HTMLDivElement; grid: HTMLDivElement },
        list: StyleTemplate[],
        headText: string
    ): void {
        group.head.textContent = headText;
        group.grid.replaceChildren();
        for (const template of list) {
            group.grid.appendChild(buildCard(template));
        }
        group.root.hidden = list.length === 0;
    }

    function render(): void {
        if (destroyed) {
            return;
        }
        for (const cleanup of cardCleanups) {
            cleanup();
        }
        cardCleanups = [];

        const query = searchInput.value.trim().toLowerCase();
        const custom = items.filter(
            (template) => template.builtin !== true && matches(template, query)
        );
        const builtins = items.filter(
            (template) => template.builtin === true && matches(template, query)
        );

        fillGroup(
            mineGroup,
            custom,
            tr("tpl.mine", "My styles ({n})", { n: custom.length })
        );
        fillGroup(
            builtinGroup,
            builtins,
            tr("tpl.builtin", "Built-in ({n})", { n: builtins.length })
        );

        empty.textContent = tr("tpl.empty", "No matching templates");
        empty.hidden = custom.length + builtins.length > 0;
    }

    function sync(list: StyleTemplate[]): void {
        if (destroyed) {
            return;
        }
        const nextSnapshot = JSON.stringify(list);
        if (nextSnapshot === snapshot) {
            return;
        }
        snapshot = nextSnapshot;
        items = list.slice();
        render();
    }

    // ---- Events ------------------------------------------------------------
    bind(saveBtn, "click", () => {
        options.onSave(nameInput.value);
        nameInput.value = "";
    });

    bind(nameInput, "keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
            event.preventDefault();
            options.onSave(nameInput.value);
            nameInput.value = "";
        }
    });

    bind(searchInput, "input", () => render());

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        for (const cleanup of cleanups) {
            cleanup();
        }
        for (const cleanup of cardCleanups) {
            cleanup();
        }
        cleanups.length = 0;
        cardCleanups = [];
        element.remove();
        container.replaceChildren();
    }

    container.appendChild(element);
    render();

    return { element, sync, destroy };
}
