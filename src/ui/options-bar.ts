/**
 * Contextual options bar: one control per visible annotation property.
 *
 * Visibility mirrors `OPT_VIS` for the effective tool (the selected
 * annotation's type while the select tool is active). Controls are created once
 * and only refreshed, so an open popup is never rebuilt while dragging.
 */
import "./options-bar.css";
import {
    BORDER_STYLES,
    CURSOR_TYPES,
    FONT_FAMILIES,
    OPT_VIS,
    STEP_TYPES,
    TRANSPARENT,
} from "../types.ts";
import type { Annotation, CursorType, TFn, ToolId, ToolOptions } from "../types.ts";
import { getIcon } from "./icons.ts";
import {
    borderPreviewStyle,
    buildChipsPopup,
    buildColorPopup,
    buildRangePopup,
    buildShadowPopup,
} from "./popups.ts";

export interface OptionsBarState {
    tool: ToolId;
    /** 选择工具下当前选中的标注（用于按 type 决定显隐与取值） */
    selected: Annotation | null;
    options: ToolOptions;
}

export interface OptionsBarApi {
    element: HTMLElement;
    sync(state: OptionsBarState): void;
    destroy(): void;
}

export interface OptionsBarPopup {
    open(anchor: HTMLElement, content: HTMLElement, opts?: { className?: string }): void;
    close(): void;
}

export interface OptionsBarOptions {
    t: TFn;
    popup: OptionsBarPopup;
    onChange(patch: Partial<ToolOptions>): void;
}

interface Control {
    prop: string;
    root: HTMLDivElement;
    btn: HTMLButtonElement;
    refresh(state: OptionsBarState): void;
    popup?(state: OptionsBarState): HTMLElement;
}

interface ControlBase {
    root: HTMLDivElement;
    btn: HTMLButtonElement;
}

const WIDTH_ITEMS = [1, 2, 3, 4, 6, 8, 12].map((width) => ({
    value: String(width),
    label: `${width}px`,
}));

const ALIGN_KEYS = ["left", "center", "right"];

export function mountOptionsBar(
    container: HTMLElement,
    options: OptionsBarOptions
): OptionsBarApi {
    const { t, popup, onChange } = options;

    const element = document.createElement("div");
    element.className = "am-options-bar";

    const badge = document.createElement("div");
    badge.className = "am-tool-badge";
    element.appendChild(badge);

    const controls: Control[] = [];
    let latest: OptionsBarState | null = null;
    let snapshot = "";
    let openProp: string | null = null;
    let openContent: HTMLElement | null = null;
    let destroyed = false;

    function createControl(prop: string, titleKey: string): ControlBase {
        const root = document.createElement("div");
        root.className = "am-opt";
        root.dataset.opt = prop;
        root.hidden = true;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "am-opt-btn";
        btn.dataset.opt = prop;
        btn.title = t(titleKey);
        btn.setAttribute("aria-label", btn.title);

        root.appendChild(btn);
        return { root, btn };
    }

    function appendIcon(btn: HTMLButtonElement, id: string): HTMLSpanElement {
        const holder = document.createElement("span");
        holder.className = "am-opt-icon";
        holder.innerHTML = getIcon(id);
        btn.appendChild(holder);
        return holder;
    }

    function appendValue(btn: HTMLButtonElement, extra?: string): HTMLSpanElement {
        const value = document.createElement("span");
        value.className = extra ? `am-opt-value ${extra}` : "am-opt-value";
        btn.appendChild(value);
        return value;
    }

    function bindPopup(control: Control): void {
        const build = control.popup;
        if (!build) {
            return;
        }
        control.btn.addEventListener("click", () => {
            if (!latest) {
                return;
            }
            const stillOpen =
                openProp === control.prop && openContent !== null && openContent.isConnected;
            if (stillOpen) {
                popup.close();
                openProp = null;
                openContent = null;
                return;
            }
            const content = build(latest);
            popup.open(control.btn, content);
            openProp = control.prop;
            openContent = content;
        });
    }

    function register(control: Control): void {
        controls.push(control);
        element.appendChild(control.root);
        bindPopup(control);
    }

    function addColor(
        prop: "stroke" | "fill" | "textColor",
        titleKey: string,
        popupTitleKey: string,
        allowTransparent: boolean,
        iconId?: string
    ): void {
        const { root, btn } = createControl(prop, titleKey);
        if (iconId) {
            appendIcon(btn, iconId);
        }
        const swatch = document.createElement("span");
        swatch.className = "am-opt-swatch";
        btn.appendChild(swatch);
        const value = appendValue(btn);

        register({
            prop,
            root,
            btn,
            refresh(state) {
                const color = state.options[prop];
                const transparent = color === TRANSPARENT;
                swatch.classList.toggle("is-transparent", transparent);
                swatch.style.background = transparent ? "" : color;
                value.textContent = transparent ? t("popup.transparent") : color.toUpperCase();
            },
            popup(state) {
                return buildColorPopup({
                    t,
                    title: t(popupTitleKey),
                    value: state.options[prop],
                    allowTransparent,
                    onPick(next) {
                        const patch: Partial<ToolOptions> = {};
                        if (prop === "stroke") {
                            patch.stroke = next;
                        } else if (prop === "fill") {
                            patch.fill = next;
                        } else {
                            patch.textColor = next;
                        }
                        onChange(patch);
                    },
                });
            },
        });
    }

    function addToggle(
        prop: "bold" | "italic" | "effectEllipse" | "tail",
        titleKey: string,
        read: (state: OptionsBarState) => boolean,
        patch: (next: boolean) => Partial<ToolOptions>,
        glyph: { text: string; className?: string } | { icon: string }
    ): void {
        const { root, btn } = createControl(prop, titleKey);
        if ("icon" in glyph) {
            appendIcon(btn, glyph.icon);
        } else {
            const span = document.createElement("span");
            span.className = glyph.className ? `am-opt-glyph ${glyph.className}` : "am-opt-glyph";
            span.textContent = glyph.text;
            btn.appendChild(span);
        }

        btn.addEventListener("click", () => {
            if (!latest) {
                return;
            }
            onChange(patch(!read(latest)));
        });

        register({
            prop,
            root,
            btn,
            refresh(state) {
                btn.classList.toggle("is-active", read(state));
            },
        });
    }

    // 1–3. Colours.
    addColor("stroke", "opt.stroke", "popup.color", false);
    addColor("fill", "opt.fill", "popup.fill", true);
    addColor("textColor", "opt.textColor", "popup.textColor", false, "text");

    // 4. Line width.
    {
        const { root, btn } = createControl("width", "opt.width");
        const dot = document.createElement("span");
        dot.className = "am-width-dot";
        btn.appendChild(dot);
        const value = appendValue(btn);
        register({
            prop: "width",
            root,
            btn,
            refresh(state) {
                const width = state.options.width;
                dot.style.width = `${width}px`;
                dot.style.height = `${width}px`;
                value.textContent = `${width}px`;
            },
            popup(state) {
                return buildChipsPopup({
                    t,
                    title: t("popup.width"),
                    items: WIDTH_ITEMS,
                    value: String(state.options.width),
                    onPick: (next) => onChange({ width: Number(next) }),
                });
            },
        });
    }

    // 5. Border style.
    {
        const { root, btn } = createControl("borderStyle", "opt.borderStyle");
        const preview = document.createElement("span");
        preview.className = "am-border-preview";
        btn.appendChild(preview);
        const value = appendValue(btn);
        register({
            prop: "borderStyle",
            root,
            btn,
            refresh(state) {
                const style = state.options.borderStyle;
                preview.style.borderTopStyle = borderPreviewStyle(style);
                value.textContent = t(`border.${style}`);
            },
            popup(state) {
                return buildChipsPopup({
                    t,
                    title: t("popup.borderStyle"),
                    items: BORDER_STYLES.map((style) => ({
                        value: style,
                        label: t(`border.${style}`),
                        preview: "border" as const,
                    })),
                    value: state.options.borderStyle,
                    onPick: (next) =>
                        onChange({ borderStyle: next as ToolOptions["borderStyle"] }),
                });
            },
        });
    }

    // 6. Corner radius.
    {
        const { root, btn } = createControl("corner", "opt.corner");
        appendIcon(btn, "square");
        const value = appendValue(btn);
        register({
            prop: "corner",
            root,
            btn,
            refresh(state) {
                value.textContent = String(state.options.corner);
            },
            popup(state) {
                return buildRangePopup({
                    t,
                    title: t("popup.corner"),
                    value: state.options.corner,
                    min: 0,
                    max: 50,
                    onInput: (next) => onChange({ corner: next }),
                });
            },
        });
    }

    // 7. Font family.
    {
        const { root, btn } = createControl("fontFamily", "opt.fontFamily");
        const value = appendValue(btn, "am-opt-value--ellipsis");
        register({
            prop: "fontFamily",
            root,
            btn,
            refresh(state) {
                value.textContent = state.options.fontFamily;
            },
            popup(state) {
                return buildChipsPopup({
                    t,
                    title: t("popup.fontFamily"),
                    items: FONT_FAMILIES.map((family) => ({
                        value: family,
                        label: family,
                    })),
                    value: state.options.fontFamily,
                    onPick: (next) => onChange({ fontFamily: next }),
                });
            },
        });
    }

    // 8. Font size.
    {
        const { root, btn } = createControl("fontSize", "opt.fontSize");
        const value = appendValue(btn);
        register({
            prop: "fontSize",
            root,
            btn,
            refresh(state) {
                value.textContent = String(state.options.fontSize);
            },
            popup(state) {
                return buildRangePopup({
                    t,
                    title: t("popup.fontSize"),
                    value: state.options.fontSize,
                    min: 12,
                    max: 72,
                    onInput: (next) => onChange({ fontSize: next }),
                });
            },
        });
    }

    // 9. Text alignment.
    {
        const { root, btn } = createControl("align", "opt.align");
        const value = appendValue(btn);
        register({
            prop: "align",
            root,
            btn,
            refresh(state) {
                value.textContent = t(`align.${state.options.align}`);
            },
            popup(state) {
                return buildChipsPopup({
                    t,
                    title: t("popup.align"),
                    items: ALIGN_KEYS.map((key) => ({
                        value: key,
                        label: t(`align.${key}`),
                    })),
                    value: state.options.align,
                    onPick: (next) => onChange({ align: next as ToolOptions["align"] }),
                });
            },
        });
    }

    // 10–11. Bold / italic.
    addToggle("bold", "opt.bold", (state) => state.options.bold, (next) => ({ bold: next }), {
        text: "B",
        className: "am-opt-glyph--bold",
    });
    addToggle(
        "italic",
        "opt.italic",
        (state) => state.options.italic,
        (next) => ({ italic: next }),
        { text: "I", className: "am-opt-glyph--italic" }
    );

    // 12. Step type.
    {
        const { root, btn } = createControl("stepType", "opt.stepType");
        const value = appendValue(btn);
        register({
            prop: "stepType",
            root,
            btn,
            refresh(state) {
                value.textContent = t(`step.${state.options.stepType}`);
            },
            popup(state) {
                return buildChipsPopup({
                    t,
                    title: t("popup.stepType"),
                    items: STEP_TYPES.map((type) => ({
                        value: type,
                        label: t(`step.${type}`),
                    })),
                    value: state.options.stepType,
                    onPick: (next) =>
                        onChange({ stepType: next as ToolOptions["stepType"] }),
                });
            },
        });
    }

    // 13. Step start.
    {
        const { root, btn } = createControl("stepStart", "opt.stepStart");
        const value = appendValue(btn);
        register({
            prop: "stepStart",
            root,
            btn,
            refresh(state) {
                value.textContent = String(state.options.stepStart);
            },
            popup(state) {
                return buildRangePopup({
                    t,
                    title: t("popup.stepStart"),
                    value: state.options.stepStart,
                    min: 1,
                    max: 20,
                    onInput: (next) => onChange({ stepStart: next }),
                });
            },
        });
    }

    // 14. Strength.
    {
        const { root, btn } = createControl("strength", "opt.strength");
        appendIcon(btn, "sliders");
        const value = appendValue(btn);
        register({
            prop: "strength",
            root,
            btn,
            refresh(state) {
                value.textContent = `${state.options.strength}%`;
            },
            popup(state) {
                return buildRangePopup({
                    t,
                    title: t("popup.strength"),
                    value: state.options.strength,
                    min: 10,
                    max: 100,
                    onInput: (next) => onChange({ strength: next }),
                });
            },
        });
    }

    // 15. Spotlight blur.
    {
        const { root, btn } = createControl("spotlightBlur", "opt.spotlightBlur");
        appendIcon(btn, "droplet");
        const value = appendValue(btn);
        register({
            prop: "spotlightBlur",
            root,
            btn,
            refresh(state) {
                value.textContent = String(state.options.spotlightBlur);
            },
            popup(state) {
                return buildRangePopup({
                    t,
                    title: t("popup.spotlightBlur"),
                    value: state.options.spotlightBlur,
                    min: 0,
                    max: 30,
                    onInput: (next) => onChange({ spotlightBlur: next }),
                });
            },
        });
    }

    // 16. Region shape (ellipse / rectangle).
    {
        const { root, btn } = createControl("effectEllipse", "opt.effectEllipse");
        const icon = appendIcon(btn, "circle-dot");
        btn.addEventListener("click", () => {
            if (!latest) {
                return;
            }
            onChange({ effectEllipse: !latest.options.effectEllipse });
        });
        register({
            prop: "effectEllipse",
            root,
            btn,
            refresh(state) {
                const ellipse = state.options.effectEllipse;
                icon.innerHTML = getIcon(ellipse ? "circle-dot" : "square");
                btn.classList.toggle("is-active", ellipse);
            },
        });
    }

    // 17. Speech tail.
    {
        const { root, btn } = createControl("tail", "opt.tail");
        appendIcon(btn, "speech");
        btn.addEventListener("click", () => {
            if (!latest) {
                return;
            }
            onChange({ tail: !latest.options.tail });
        });
        register({
            prop: "tail",
            root,
            btn,
            refresh(state) {
                btn.classList.toggle("is-active", state.options.tail);
            },
        });
    }

    // 18. Cursor type.
    {
        const { root, btn } = createControl("cursorType", "opt.cursorType");
        appendIcon(btn, "cursor");
        const value = appendValue(btn);
        register({
            prop: "cursorType",
            root,
            btn,
            refresh(state) {
                value.textContent = t(`cursor.${state.options.cursorType}`);
            },
            popup(state) {
                return buildChipsPopup({
                    t,
                    title: t("opt.cursorType"),
                    items: CURSOR_TYPES.map((type) => ({
                        value: type,
                        label: t(`cursor.${type}`),
                    })),
                    value: state.options.cursorType,
                    onPick: (next) => onChange({ cursorType: next as CursorType }),
                });
            },
        });
    }

    // 19. Shadow.
    {
        const { root, btn } = createControl("shadow", "opt.shadow");
        appendIcon(btn, "layers");
        const value = appendValue(btn);
        register({
            prop: "shadow",
            root,
            btn,
            refresh(state) {
                const enabled = state.options.shadow.enabled;
                btn.classList.toggle("is-active", enabled);
                value.textContent = enabled ? t("common.on") : t("common.off");
            },
            popup(state) {
                const base = state.options.shadow;
                return buildShadowPopup({
                    t,
                    value: base,
                    onChange(patch) {
                        const current = latest ? latest.options.shadow : base;
                        onChange({ shadow: { ...current, ...patch } });
                    },
                });
            },
        });
    }

    function sync(state: OptionsBarState): void {
        if (destroyed) {
            return;
        }
        latest = state;

        const selectedId = state.selected ? state.selected.id : "";
        const nextSnapshot = `${state.tool}|${selectedId}|${JSON.stringify(state.options)}`;
        if (nextSnapshot === snapshot) {
            return;
        }
        snapshot = nextSnapshot;

        const effective: ToolId =
            state.tool === "select" && state.selected ? state.selected.type : state.tool;
        badge.textContent = t(`tool.${effective}`);

        // The select tool without a selection exposes no properties at all.
        const hasSelection = !(state.tool === "select" && !state.selected);
        for (const control of controls) {
            const visible = hasSelection && (OPT_VIS[control.prop] ?? []).includes(effective);
            control.root.hidden = !visible;
            control.refresh(state);
        }
    }

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        if (openContent !== null && openContent.isConnected) {
            popup.close();
        }
        openProp = null;
        openContent = null;
        latest = null;
        snapshot = "";
        controls.length = 0;
        element.remove();
    }

    container.appendChild(element);

    return { element, sync, destroy };
}
