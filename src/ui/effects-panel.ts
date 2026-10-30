/**
 * Floating effect browser mounted into the shell's `.am-fx-panel` slot.
 *
 * Two pinned groups (recent + favourites) come first, followed by the four
 * collapsible `EFFECT_CATEGORIES`. Items are rendered as plain buttons; the
 * same effect may appear in several groups at once. The recent / favourite
 * lists persist in localStorage and are only rebuilt when they change, so the
 * search text and collapse state survive a refresh.
 *
 * Applying an effect records it as the most recent entry, hands it to the
 * editor with the clicked button as anchor and then closes the overlay.
 */
import "./effects-panel.css";
import { EFFECT_CATALOG, EFFECT_CATEGORIES, findEffect } from "../effects/catalog.ts";
import type { AppliedEffect, EffectCategory, EffectDef } from "../effects/types.ts";
import type { TFn } from "../types.ts";
import { ICONS, getIcon, iconButton } from "./icons.ts";

export interface EffectsPanelApi {
    element: HTMLElement;
    sync(stack: AppliedEffect[]): void;
    destroy(): void;
}

export interface EffectsPanelOptions {
    t: TFn;
    onApply(def: EffectDef, anchor: HTMLElement): void;
    onClose(): void;
}

interface CatalogItem {
    def: EffectDef;
    btn: HTMLButtonElement;
    star: HTMLSpanElement;
    /** pre-lowered hash used by the search box */
    search: string;
}

type GroupKind = "recent" | "favorite" | EffectCategory;

interface EffectGroup {
    kind: GroupKind;
    root: HTMLDivElement;
    body: HTMLDivElement;
    count: HTMLSpanElement;
    items: CatalogItem[];
}

type Cleanup = () => void;

const RECENTS_KEY = "anno-mark.fx-recents.v1";
const FAVORITES_KEY = "anno-mark.fx-favorites.v1";
const MAX_RECENTS = 10;

/** English labels used when the dictionary has no new-shape category key. */
const CATEGORY_FALLBACK: Record<EffectCategory, string> = {
    manipulation: "Manipulations",
    adjustment: "Adjustments",
    filter: "Filters",
    drawing: "Drawings",
};

/** Shown when an effect id has no dedicated glyph of its own. */
const CATEGORY_ICON: Record<EffectCategory, string> = {
    manipulation: "crop",
    adjustment: "sliders",
    filter: "sparkles",
    drawing: "brush",
};

/** Reads a persisted id list, silently degrading when storage is unavailable. */
function loadIds(key: string, limit: number | null): string[] {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const out: string[] = [];
        for (const value of parsed) {
            if (typeof value !== "string" || out.includes(value) || !findEffect(value)) {
                continue;
            }
            out.push(value);
            if (limit !== null && out.length >= limit) {
                break;
            }
        }
        return out;
    } catch {
        return [];
    }
}

/** Persists an id list; failures (private mode, quota) are ignored. */
function saveIds(key: string, ids: string[]): void {
    try {
        window.localStorage.setItem(key, JSON.stringify(ids));
    } catch {
        // Storage may be unavailable; the in-memory list still works.
    }
}

export function mountEffectsPanel(
    container: HTMLElement,
    options: EffectsPanelOptions
): EffectsPanelApi {
    const { t, onApply, onClose } = options;
    const cleanups: Cleanup[] = [];
    const collapsed = new Set<EffectCategory>();
    const categoryGroups: EffectGroup[] = [];
    let pinnedGroups: EffectGroup[] = [];
    let recents = loadIds(RECENTS_KEY, MAX_RECENTS);
    let favorites = loadIds(FAVORITES_KEY, null);
    let favoriteSet = new Set(favorites);
    let activeIds = new Set<string>();
    let destroyed = false;

    const element = document.createElement("div");
    element.className = "am-panel am-effects-panel";

    function bind(
        target: EventTarget,
        type: string,
        handler: (event: Event) => void
    ): void {
        target.addEventListener(type, handler);
        cleanups.push(() => target.removeEventListener(type, handler));
    }

    /** `t` falls back to the key itself, so callers supply an English default. */
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

    function effectName(def: EffectDef): string {
        const text = t(def.labelKey);
        return text === def.labelKey ? def.name : text;
    }

    function allGroups(): EffectGroup[] {
        return pinnedGroups.concat(categoryGroups);
    }

    // ---- Header ------------------------------------------------------------
    const head = document.createElement("div");
    head.className = "am-fx-head";

    const headIcon = document.createElement("span");
    headIcon.className = "am-fx-head-icon";
    headIcon.innerHTML = getIcon("wand");

    const headText = document.createElement("div");
    headText.className = "am-fx-head-text";
    const title = document.createElement("div");
    title.className = "am-fx-title";
    title.textContent = tr("effects.title", "Effects");
    const subtitle = document.createElement("div");
    subtitle.className = "am-fx-sub";
    headText.append(title, subtitle);

    const closeLabel = t("common.close");
    const closeBtn = iconButton("close", closeLabel, "am-fx-close");
    bind(closeBtn, "click", () => onClose());

    head.append(headIcon, headText, closeBtn);
    element.appendChild(head);

    // ---- Search ------------------------------------------------------------
    const searchBar = document.createElement("div");
    searchBar.className = "am-fx-searchbar";
    const search = document.createElement("div");
    search.className = "am-search";
    search.innerHTML = getIcon("search");
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    const placeholder = tr("effects.searchTotal", "Search effects ({n})", {
        n: EFFECT_CATALOG.length,
    });
    searchInput.placeholder = placeholder;
    searchInput.setAttribute("aria-label", placeholder);
    search.appendChild(searchInput);
    searchBar.appendChild(search);
    element.appendChild(searchBar);

    // ---- Scrollable catalog ------------------------------------------------
    const body = document.createElement("div");
    body.className = "am-fx-body";
    const pinned = document.createElement("div");
    pinned.className = "am-fx-pinned";
    body.appendChild(pinned);
    element.appendChild(body);

    const empty = document.createElement("div");
    empty.className = "am-hint am-fx-empty";
    empty.textContent = tr("effects.empty", "No matching effects");
    empty.hidden = true;

    const foot = document.createElement("div");
    foot.className = "am-fx-foot";
    foot.textContent = tr(
        "effects.footHint",
        "Click to apply · Right-click to favorite or remove from recent"
    );
    element.appendChild(foot);

    // ---- Item / group construction ----------------------------------------
    function createItem(def: EffectDef): CatalogItem {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "am-effect-item";
        btn.dataset.id = def.id;
        btn.innerHTML = getIcon(
            ICONS[def.id] ? def.id : CATEGORY_ICON[def.category]
        );
        btn.title = def.name;

        const label = effectName(def);
        const name = document.createElement("span");
        name.className = "am-fx-name";
        name.textContent = label;

        const star = document.createElement("span");
        star.className = "am-fx-star";
        star.innerHTML = getIcon("star");
        star.hidden = !favoriteSet.has(def.id);

        btn.append(name, star);
        return {
            def,
            btn,
            star,
            search: `${label}\u0000${def.name}\u0000${def.id}`.toLowerCase(),
        };
    }

    function fillBody(group: EffectGroup, defs: EffectDef[]): void {
        for (const def of defs) {
            const item = createItem(def);
            group.items.push(item);
            group.body.appendChild(item.btn);
        }
    }

    function buildPinnedGroup(
        kind: "recent" | "favorite",
        label: string,
        icon: string,
        defs: EffectDef[]
    ): EffectGroup {
        const root = document.createElement("div");
        root.className = "am-effect-cat am-fx-group is-pinned";
        root.dataset.cat = kind;

        const groupHead = document.createElement("div");
        groupHead.className = "am-effect-cat-head am-effect-cat-head--pinned";

        const iconEl = document.createElement("span");
        iconEl.className = "am-effect-cat-ico";
        iconEl.innerHTML = getIcon(icon);

        const nameEl = document.createElement("span");
        nameEl.className = "am-effect-cat-name";
        nameEl.textContent = label;

        const count = document.createElement("span");
        count.className = "am-count";

        groupHead.append(iconEl, nameEl, count);

        const groupBody = document.createElement("div");
        groupBody.className = "am-effect-items";

        const group: EffectGroup = {
            kind,
            root,
            body: groupBody,
            count,
            items: [],
        };
        fillBody(group, defs);

        root.append(groupHead, groupBody);
        return group;
    }

    function buildCategoryGroup(category: EffectCategory): EffectGroup {
        const meta = EFFECT_CATEGORIES.find((entry) => entry.id === category);
        const root = document.createElement("div");
        root.className = "am-effect-cat am-fx-group";
        root.dataset.cat = category;

        const headBtn = document.createElement("button");
        headBtn.type = "button";
        headBtn.className = "am-effect-cat-head";
        headBtn.setAttribute("aria-expanded", "true");
        const hint = meta ? tr(meta.hintKey, "") : "";
        if (hint) {
            headBtn.title = hint;
        }

        const chevron = document.createElement("span");
        chevron.className = "am-effect-cat-chevron";
        chevron.innerHTML = getIcon("chevron-down");

        const nameEl = document.createElement("span");
        nameEl.className = "am-effect-cat-name";
        nameEl.textContent = meta
            ? tr(meta.labelKey, CATEGORY_FALLBACK[category])
            : CATEGORY_FALLBACK[category];

        const count = document.createElement("span");
        count.className = "am-count";

        headBtn.append(chevron, nameEl, count);

        const groupBody = document.createElement("div");
        groupBody.className = "am-effect-items";

        const group: EffectGroup = {
            kind: category,
            root,
            body: groupBody,
            count,
            items: [],
        };
        fillBody(
            group,
            EFFECT_CATALOG.filter((def) => def.category === category)
        );

        bind(headBtn, "click", () => {
            const next = !collapsed.has(category);
            if (next) {
                collapsed.add(category);
            } else {
                collapsed.delete(category);
            }
            root.classList.toggle("is-collapsed", next);
            groupBody.hidden = next;
            headBtn.setAttribute("aria-expanded", next ? "false" : "true");
        });

        root.append(headBtn, groupBody);
        return group;
    }

    function applyActive(): void {
        for (const group of allGroups()) {
            for (const item of group.items) {
                item.btn.classList.toggle("is-active", activeIds.has(item.def.id));
            }
        }
    }

    function syncCategoryStars(): void {
        for (const group of categoryGroups) {
            for (const item of group.items) {
                item.star.hidden = !favoriteSet.has(item.def.id);
            }
        }
    }

    function rebuildPinned(): void {
        pinnedGroups = [];
        pinned.replaceChildren();

        const recentDefs: EffectDef[] = [];
        for (const id of recents) {
            const def = findEffect(id);
            if (def) {
                recentDefs.push(def);
            }
        }
        const favoriteDefs: EffectDef[] = [];
        for (const id of favorites) {
            const def = findEffect(id);
            if (def) {
                favoriteDefs.push(def);
            }
        }

        pinnedGroups.push(
            buildPinnedGroup(
                "recent",
                tr("effects.recent", "Recent"),
                "history",
                recentDefs
            ),
            buildPinnedGroup(
                "favorite",
                tr("effects.favorites", "Favorites"),
                "star",
                favoriteDefs
            )
        );
        pinned.append(pinnedGroups[0].root, pinnedGroups[1].root);
        applyActive();
    }

    // ---- Filtering ---------------------------------------------------------
    function applyFilter(query: string): void {
        const q = query.trim().toLowerCase();
        let shown = 0;
        let cats = 0;
        for (const group of allGroups()) {
            let visible = 0;
            for (const item of group.items) {
                const match = q === "" || item.search.includes(q);
                item.btn.hidden = !match;
                if (match) {
                    visible += 1;
                }
            }
            group.count.textContent = String(visible);
            group.root.hidden = visible === 0;
            if (
                group.kind !== "recent" &&
                group.kind !== "favorite" &&
                visible > 0
            ) {
                cats += 1;
            }
            shown += visible;
        }
        empty.hidden = shown !== 0;
        subtitle.textContent = tr(
            "effects.subtitle",
            "{shown} / {total} · {cats} categories",
            {
                shown,
                total: EFFECT_CATALOG.length,
                cats,
            }
        );
    }

    function refresh(): void {
        syncCategoryStars();
        rebuildPinned();
        applyFilter(searchInput.value);
    }

    // ---- Recent / favourite mutations --------------------------------------
    function registerRecent(id: string): void {
        recents = [id]
            .concat(recents.filter((value) => value !== id))
            .slice(0, MAX_RECENTS);
        saveIds(RECENTS_KEY, recents);
    }

    function removeRecent(id: string): void {
        recents = recents.filter((value) => value !== id);
        saveIds(RECENTS_KEY, recents);
    }

    function toggleFavorite(id: string): void {
        favorites = favoriteSet.has(id)
            ? favorites.filter((value) => value !== id)
            : [id].concat(favorites.filter((value) => value !== id));
        favoriteSet = new Set(favorites);
        saveIds(FAVORITES_KEY, favorites);
    }

    // ---- Interaction -------------------------------------------------------
    function itemButton(event: Event): HTMLButtonElement | null {
        const target = event.target;
        if (!(target instanceof Element)) {
            return null;
        }
        const btn = target.closest<HTMLButtonElement>(".am-effect-item");
        if (!btn || !body.contains(btn)) {
            return null;
        }
        return btn;
    }

    bind(body, "click", (event) => {
        const btn = itemButton(event);
        if (!btn) {
            return;
        }
        const id = btn.dataset.id;
        const def = id ? findEffect(id) : undefined;
        if (!def) {
            return;
        }
        registerRecent(def.id);
        onApply(def, btn);
        refresh();
        onClose();
    });

    bind(body, "contextmenu", (event) => {
        const btn = itemButton(event);
        if (!btn) {
            return;
        }
        const id = btn.dataset.id;
        if (!id || !findEffect(id)) {
            return;
        }
        event.preventDefault();
        const group = btn.closest<HTMLElement>(".am-fx-group");
        if (group?.dataset.cat === "recent") {
            removeRecent(id);
        } else {
            toggleFavorite(id);
        }
        refresh();
    });

    bind(searchInput, "input", () => applyFilter(searchInput.value));

    // ---- Stack sync --------------------------------------------------------
    function sync(stack: AppliedEffect[]): void {
        if (destroyed) {
            return;
        }
        activeIds = new Set(stack.map((item) => item.id));
        applyActive();
    }

    // ---- Lifecycle ---------------------------------------------------------
    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        for (const cleanup of cleanups) {
            cleanup();
        }
        cleanups.length = 0;
        pinnedGroups.length = 0;
        categoryGroups.length = 0;
        element.remove();
        container.replaceChildren();
    }

    // ---- Initial mount -----------------------------------------------------
    for (const category of EFFECT_CATEGORIES) {
        const group = buildCategoryGroup(category.id);
        categoryGroups.push(group);
        body.appendChild(group.root);
    }
    body.appendChild(empty);
    container.appendChild(element);

    refresh();

    return { element, sync, destroy };
}
