/**
 * Left sidebar: background composition panel.
 *
 * Mirrors the prototype background card: margin / padding (with smart padding),
 * corner radius, shadow radius, output ratio, and the three background modes
 * (solid / gradient with 8 presets / local image).
 *
 * The panel owns no state. Every edit is reported through `onChange`; the
 * authoritative `BgState` comes back through `sync`, which only refreshes the
 * existing controls. Slider drags are throttled with `requestAnimationFrame` so
 * the canvas can relayout at most once per frame.
 */
import "./background-panel.css";
import { GRADIENT_PRESETS, RATIO_OPTIONS } from "../types.ts";
import type { BgState, TFn } from "../types.ts";
import { getIcon } from "./icons.ts";

export interface BackgroundPanelApi {
    element: HTMLElement;
    sync(bg: BgState): void;
    destroy(): void;
}

export interface BackgroundPanelOptions {
    t: TFn;
    bg: BgState;
    onChange(patch: Partial<BgState>): void;
    /** 打开本地图片选择，返回 data URL；用户取消返回 null */
    onPickImage(): Promise<string | null>;
}

interface RangeControl {
    field: HTMLDivElement;
    input: HTMLInputElement;
    value: HTMLElement;
}

type Cleanup = () => void;

const RANGE_MAX = 200;
const CORNER_MAX = 50;
const SHADOW_MAX = 100;
const MODES: Array<BgState["mode"]> = ["solid", "gradient", "image", "checker"];

/** `<input type="color">` only accepts `#rrggbb`; fall back for odd values. */
function colorValue(value: string, fallback: string): string {
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function readAsDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
        reader.addEventListener("error", () =>
            reject(reader.error ?? new Error("background image read failed"))
        );
        reader.readAsDataURL(file);
    });
}

export function mountBackgroundPanel(
    container: HTMLElement,
    options: BackgroundPanelOptions
): BackgroundPanelApi {
    const { t, onChange } = options;
    const cleanups: Cleanup[] = [];

    let current: BgState = { ...options.bg };
    let snapshot = "";
    let destroyed = false;
    let rafId = 0;
    let pending: Partial<BgState> | null = null;

    const element = document.createElement("div");
    element.className = "am-panel am-bg-panel";

    function bind(
        target: EventTarget,
        type: string,
        handler: (event: Event) => void
    ): void {
        target.addEventListener(type, handler);
        cleanups.push(() => target.removeEventListener(type, handler));
    }

    function sync(bg: BgState): void {
        if (destroyed) {
            return;
        }
        const nextSnapshot = JSON.stringify(bg);
        if (nextSnapshot === snapshot) {
            return;
        }
        snapshot = nextSnapshot;
        current = { ...bg };

        setRange(margin, bg.margin);
        setRange(corner, bg.corner);
        setRange(shadow, bg.shadow);

        padding.input.max = String(bg.smartPadding ? Math.min(RANGE_MAX, bg.margin) : RANGE_MAX);
        setRange(padding, bg.padding);
        smartInput.checked = bg.smartPadding;

        for (const [ratio, btn] of ratioButtons) {
            const active = ratio === bg.ratio;
            btn.classList.toggle("is-active", active);
            btn.setAttribute("aria-pressed", active ? "true" : "false");
        }

        for (const [mode, btn] of modeButtons) {
            btn.classList.toggle("is-active", mode === bg.mode);
        }

        solidField.hidden = bg.mode !== "solid";
        gradientField.hidden = bg.mode !== "gradient";
        imageField.hidden = bg.mode !== "image";

        solidSwatch.style.backgroundColor = bg.solid;
        solidHint.textContent = bg.solid.toUpperCase();
        solidColor.value = colorValue(bg.solid, "#3e83f2");

        fromHalf.style.backgroundColor = bg.gradientFrom;
        toHalf.style.backgroundColor = bg.gradientTo;
        stopsHint.textContent = `${bg.gradientFrom} → ${bg.gradientTo}`;
        fromColor.value = colorValue(bg.gradientFrom, "#8b5cf6");
        toColor.value = colorValue(bg.gradientTo, "#22d3ee");
        presetButtons.forEach((btn, index) => {
            btn.classList.toggle("is-active", index === bg.gradient);
        });

        imageBtn.textContent = bg.imageSrc ? t("bg.replaceImage") : t("bg.pickImage");
        imageHint.textContent = t("bg.imageSelected");
        imageHint.hidden = !bg.imageSrc;
    }

    function setRange(control: RangeControl, value: number): void {
        control.input.value = String(value);
        control.value.textContent = `${value} px`;
    }

    function emit(patch: Partial<BgState>): void {
        current = { ...current, ...patch };
        sync(current);
        onChange(patch);
    }

    function queue(patch: Partial<BgState>): void {
        pending = { ...(pending ?? {}), ...patch };
        if (rafId !== 0) {
            return;
        }
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            const next = pending;
            pending = null;
            if (next === null || destroyed) {
                return;
            }
            emit(next);
        });
    }

    function createRange(
        key: "margin" | "padding" | "corner" | "shadow",
        labelKey: string,
        max: number
    ): RangeControl {
        const field = document.createElement("div");
        field.className = "am-field";
        field.dataset.field = key;

        const row = document.createElement("div");
        row.className = "am-field-row";
        const name = document.createElement("span");
        name.textContent = t(labelKey);
        const value = document.createElement("b");
        value.className = "am-capsule";
        value.textContent = `${current[key]} px`;
        row.append(name, value);

        const input = document.createElement("input");
        input.type = "range";
        input.className = "am-range";
        input.min = "0";
        input.max = String(max);
        input.step = "1";
        input.value = String(current[key]);
        input.setAttribute("aria-label", t(labelKey));

        field.append(row, input);
        element.appendChild(field);
        return { field, input, value };
    }

    function createButton(className: string, label: string): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = className;
        btn.textContent = label;
        return btn;
    }

    function createHiddenInput(type: string): HTMLInputElement {
        const input = document.createElement("input");
        input.type = type;
        input.className = "am-hidden-input";
        input.tabIndex = -1;
        input.setAttribute("aria-hidden", "true");
        element.appendChild(input);
        return input;
    }

    // ---- Title -------------------------------------------------------------
    const title = document.createElement("h3");
    title.className = "am-panel-title";
    title.innerHTML = getIcon("layout");
    const titleText = document.createElement("span");
    titleText.textContent = t("bg.title");
    title.appendChild(titleText);
    element.appendChild(title);

    // ---- Ranges ------------------------------------------------------------
    const margin = createRange("margin", "bg.margin", RANGE_MAX);
    const padding = createRange("padding", "bg.padding", RANGE_MAX);
    const corner = createRange("corner", "bg.corner", CORNER_MAX);
    const shadow = createRange("shadow", "bg.shadow", SHADOW_MAX);

    const smartRow = document.createElement("label");
    smartRow.className = "am-switch-row";
    const smartText = document.createElement("span");
    smartText.textContent = t("bg.smartPadding");
    const smartInput = document.createElement("input");
    smartInput.type = "checkbox";
    smartInput.checked = current.smartPadding;
    const smartTrack = document.createElement("i");
    smartTrack.className = "am-switch";
    smartRow.append(smartText, smartInput, smartTrack);
    padding.field.appendChild(smartRow);

    bind(margin.input, "input", () => {
        const next = Number(margin.input.value);
        margin.value.textContent = `${next} px`;
        const patch: Partial<BgState> = { margin: next };
        if (current.smartPadding) {
            padding.input.max = String(Math.min(RANGE_MAX, next));
            if (current.padding > next) {
                patch.padding = next;
                padding.value.textContent = `${next} px`;
            }
        }
        current = { ...current, ...patch };
        queue(patch);
    });

    bind(padding.input, "input", () => {
        const next = Number(padding.input.value);
        padding.value.textContent = `${next} px`;
        current = { ...current, padding: next };
        queue({ padding: next });
    });

    bind(corner.input, "input", () => {
        const next = Number(corner.input.value);
        corner.value.textContent = `${next} px`;
        current = { ...current, corner: next };
        queue({ corner: next });
    });

    bind(shadow.input, "input", () => {
        const next = Number(shadow.input.value);
        shadow.value.textContent = `${next} px`;
        current = { ...current, shadow: next };
        queue({ shadow: next });
    });

    bind(smartInput, "change", () => {
        if (smartInput.checked) {
            if (current.padding > current.margin) {
                emit({ smartPadding: true, padding: current.margin });
            } else {
                emit({ smartPadding: true });
            }
        } else {
            emit({ smartPadding: false });
        }
    });

    // ---- Ratio -------------------------------------------------------------
    const ratioField = document.createElement("div");
    ratioField.className = "am-field";
    const ratioLabel = document.createElement("span");
    ratioLabel.className = "am-field-label";
    ratioLabel.textContent = t("bg.ratio");
    const ratioGrid = document.createElement("div");
    ratioGrid.className = "am-ratio-grid";
    ratioField.append(ratioLabel, ratioGrid);

    const ratioButtons = new Map<string, HTMLButtonElement>();
    for (const ratio of RATIO_OPTIONS) {
        const label = ratio === "Auto" ? t("bg.ratioAuto") : ratio;
        const btn = createButton("", label);
        btn.dataset.ratio = ratio;
        bind(btn, "click", () => emit({ ratio }));
        ratioButtons.set(ratio, btn);
        ratioGrid.appendChild(btn);
    }
    element.appendChild(ratioField);

    // ---- Background mode ---------------------------------------------------
    const modeField = document.createElement("div");
    modeField.className = "am-field";
    const modeLabel = document.createElement("span");
    modeLabel.className = "am-field-label";
    modeLabel.textContent = t("bg.mode");
    const modeChips = document.createElement("div");
    modeChips.className = "am-chips";
    modeField.append(modeLabel, modeChips);

    const modeButtons = new Map<BgState["mode"], HTMLButtonElement>();
    for (const mode of MODES) {
        const btn = createButton("am-chip", t(`bg.mode.${mode}`));
        bind(btn, "click", () => emit({ mode }));
        modeButtons.set(mode, btn);
        modeChips.appendChild(btn);
    }
    element.appendChild(modeField);

    // ---- Solid -------------------------------------------------------------
    const solidField = document.createElement("div");
    solidField.className = "am-field";
    solidField.dataset.mode = "solid";
    const solidLabel = document.createElement("span");
    solidLabel.className = "am-field-label";
    solidLabel.textContent = t("bg.solid");
    const solidPreview = document.createElement("div");
    solidPreview.className = "am-gradient-preview";
    const solidSwatch = createButton("am-bg-swatch", "");
    solidSwatch.setAttribute("aria-label", t("bg.solid"));
    solidPreview.appendChild(solidSwatch);
    const solidHint = document.createElement("div");
    solidHint.className = "am-hint";
    solidField.append(solidLabel, solidPreview, solidHint);
    element.appendChild(solidField);

    // ---- Gradient ----------------------------------------------------------
    const gradientField = document.createElement("div");
    gradientField.className = "am-field";
    gradientField.dataset.mode = "gradient";
    const gradientLabel = document.createElement("span");
    gradientLabel.className = "am-field-label";
    gradientLabel.textContent = t("bg.gradient");

    const gradientPreview = document.createElement("div");
    gradientPreview.className = "am-gradient-preview";
    const fromHalf = createButton("ghalf", "");
    fromHalf.title = t("bg.from");
    fromHalf.setAttribute("aria-label", t("bg.from"));
    const toHalf = createButton("ghalf", "");
    toHalf.title = t("bg.to");
    toHalf.setAttribute("aria-label", t("bg.to"));
    gradientPreview.append(fromHalf, toHalf);

    const stopsHint = document.createElement("div");
    stopsHint.className = "am-hint am-bg-stops";

    const presetsLabel = document.createElement("span");
    presetsLabel.className = "am-field-label";
    presetsLabel.textContent = t("bg.presets");
    const presetGrid = document.createElement("div");
    presetGrid.className = "am-preset-grid";

    const presetButtons: HTMLButtonElement[] = [];
    GRADIENT_PRESETS.forEach(([from, to], index) => {
        const btn = createButton("", "");
        btn.title = `${from} → ${to}`;
        btn.setAttribute("aria-label", `${t("bg.presets")} ${index + 1}`);
        btn.style.background = `linear-gradient(135deg, ${from}, ${to})`;
        bind(btn, "click", () =>
            emit({ gradient: index, gradientFrom: from, gradientTo: to })
        );
        presetButtons.push(btn);
        presetGrid.appendChild(btn);
    });

    gradientField.append(
        gradientLabel,
        gradientPreview,
        stopsHint,
        presetsLabel,
        presetGrid
    );
    element.appendChild(gradientField);

    // ---- Image -------------------------------------------------------------
    const imageField = document.createElement("div");
    imageField.className = "am-field";
    imageField.dataset.mode = "image";
    const imageBtn = createButton("am-ghost-btn", t("bg.pickImage"));
    const imageHint = document.createElement("div");
    imageHint.className = "am-hint";
    imageHint.textContent = t("bg.imageSelected");
    imageHint.hidden = true;
    imageField.append(imageBtn, imageHint);
    element.appendChild(imageField);

    // ---- Native pickers ----------------------------------------------------
    const solidColor = createHiddenInput("color");
    const fromColor = createHiddenInput("color");
    const toColor = createHiddenInput("color");
    const fileInput = createHiddenInput("file");
    fileInput.accept = "image/*";

    bind(solidSwatch, "click", () => {
        solidColor.value = colorValue(current.solid, "#3e83f2");
        solidColor.click();
    });
    bind(fromHalf, "click", () => {
        fromColor.value = colorValue(current.gradientFrom, "#8b5cf6");
        fromColor.click();
    });
    bind(toHalf, "click", () => {
        toColor.value = colorValue(current.gradientTo, "#22d3ee");
        toColor.click();
    });

    bind(solidColor, "input", () => emit({ solid: solidColor.value }));
    bind(fromColor, "input", () =>
        emit({ gradientFrom: fromColor.value, gradient: -1 })
    );
    bind(toColor, "input", () => emit({ gradientTo: toColor.value, gradient: -1 }));

    function pickFromInput(): Promise<string | null> {
        return new Promise<string | null>((resolve) => {
            fileInput.value = "";
            const finish = (result: string | null): void => {
                fileInput.removeEventListener("change", handleChange);
                fileInput.removeEventListener("cancel", handleCancel);
                resolve(result);
            };
            const handleChange = (): void => {
                const file = fileInput.files?.[0] ?? null;
                if (file === null) {
                    finish(null);
                    return;
                }
                readAsDataUrl(file).then(
                    (url) => finish(url),
                    () => finish(null)
                );
            };
            const handleCancel = (): void => finish(null);
            fileInput.addEventListener("change", handleChange);
            fileInput.addEventListener("cancel", handleCancel);
            fileInput.click();
        });
    }

    function pick(): Promise<string | null> {
        return typeof options.onPickImage === "function"
            ? options.onPickImage()
            : pickFromInput();
    }

    let picking = false;
    bind(imageBtn, "click", () => {
        if (picking) {
            return;
        }
        picking = true;
        imageBtn.disabled = true;
        void pick()
            .then((dataUrl) => {
                if (dataUrl !== null && dataUrl !== "" && !destroyed) {
                    emit({ imageSrc: dataUrl });
                }
            })
            .catch(() => undefined)
            .then(() => {
                picking = false;
                if (!destroyed) {
                    imageBtn.disabled = false;
                }
            });
    });

    // ---- Lifecycle ---------------------------------------------------------
    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        if (rafId !== 0) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        pending = null;
        for (const cleanup of cleanups) {
            cleanup();
        }
        cleanups.length = 0;
        element.remove();
        container.replaceChildren();
    }

    container.appendChild(element);
    sync(current);

    return { element, sync, destroy };
}
