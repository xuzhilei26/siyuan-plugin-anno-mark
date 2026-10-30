/**
 * Content builders for the anchored option popups.
 *
 * Every builder returns a detached DOM subtree and never positions or opens it:
 * `mountPopupLayer` owns the frame, placement and teardown. Builders keep no
 * module state, so closing a popup always discards its content.
 */
import "./popups.css";
import { PALETTE, TRANSPARENT } from "../types.ts";
import type { ShadowState, TFn } from "../types.ts";

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const BORDER_PREVIEW: Record<string, string> = {
    solid: "solid",
    dash: "dashed",
    dot: "dotted",
    dashdot: "dashed",
};

/** CSS `border-top-style` for a border-style key. */
export function borderPreviewStyle(style: string): string {
    return BORDER_PREVIEW[style] ?? "solid";
}

/** `#rgb` / `#rrggbb` / `transparent` → canonical value, otherwise `null`. */
function normalizeHex(raw: string): string | null {
    const value = raw.trim();
    if (!value) {
        return null;
    }
    if (value.toLowerCase() === TRANSPARENT) {
        return TRANSPARENT;
    }
    return HEX_RE.test(value) ? value.toUpperCase() : null;
}

/** A value `<input type="color">` accepts (#rrggbb). */
function toNativeColor(value: string): string {
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        const digits = value.slice(1).split("");
        return `#${digits.map((digit) => digit + digit).join("")}`.toUpperCase();
    }
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "#000000";
}

/** 通用弹层外壳：标题 + 内容 */
export function popupShell(title: string, body: HTMLElement, className?: string): HTMLElement {
    const root = document.createElement("div");
    root.className = className ? `am-pop ${className}` : "am-pop";

    const heading = document.createElement("div");
    heading.className = "am-pop-title";
    heading.textContent = title;

    const wrapper = document.createElement("div");
    wrapper.className = "am-pop-body";
    wrapper.appendChild(body);

    root.append(heading, wrapper);
    return root;
}

export function buildColorPopup(opts: {
    t: TFn;
    title: string;
    value: string;
    allowTransparent?: boolean;
    onPick(value: string): void;
}): HTMLElement {
    const body = document.createElement("div");

    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "am-hex";
    hex.maxLength = 9;
    hex.spellcheck = false;
    hex.setAttribute("aria-label", opts.title);
    hex.value = opts.value === TRANSPARENT ? "" : opts.value.toUpperCase();

    const native = document.createElement("input");
    native.type = "color";
    native.className = "am-native-color";
    native.setAttribute("aria-label", opts.title);
    native.value = toNativeColor(opts.value);

    const swatches = document.createElement("div");
    swatches.className = "am-swatches";
    const buttons: HTMLButtonElement[] = [];

    const markActive = (color: string): void => {
        for (const button of buttons) {
            const own = button.dataset.color ?? "";
            button.classList.toggle("is-active", own.toLowerCase() === color.toLowerCase());
        }
    };

    const addSwatch = (color: string, label: string, transparent = false): void => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "am-swatch";
        button.dataset.color = color;
        button.title = label;
        button.setAttribute("aria-label", label);
        if (transparent) {
            button.classList.add("is-transparent");
        } else {
            button.style.background = color;
        }
        button.classList.toggle(
            "is-active",
            color.toLowerCase() === opts.value.toLowerCase()
        );
        button.addEventListener("click", () => {
            markActive(color);
            hex.value = color === TRANSPARENT ? "" : color.toUpperCase();
            native.value = toNativeColor(color);
            opts.onPick(color);
        });
        buttons.push(button);
        swatches.appendChild(button);
    };

    if (opts.allowTransparent) {
        addSwatch(TRANSPARENT, opts.t("popup.transparent"), true);
    }
    for (const color of PALETTE) {
        addSwatch(color, color);
    }

    hex.addEventListener("input", () => {
        const next = normalizeHex(hex.value);
        if (!next) {
            return;
        }
        markActive(next);
        if (next !== TRANSPARENT) {
            native.value = toNativeColor(next);
        }
        opts.onPick(next);
    });

    native.addEventListener("input", () => {
        const next = native.value.toUpperCase();
        hex.value = next;
        markActive(next);
        opts.onPick(next);
    });

    const row = document.createElement("div");
    row.className = "am-pop-hex-row";
    row.append(hex, native);
    body.append(swatches, row);

    return popupShell(opts.title, body, "am-pop--color");
}

export function buildChipsPopup(opts: {
    t: TFn;
    title: string;
    items: Array<{ value: string; label: string; preview?: "border" }>;
    value: string;
    onPick(value: string): void;
}): HTMLElement {
    const chips = document.createElement("div");
    chips.className = "am-chips";
    const buttons: HTMLButtonElement[] = [];

    for (const item of opts.items) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "am-chip";
        chip.dataset.value = item.value;
        chip.classList.toggle("is-active", item.value === opts.value);
        if (item.preview === "border") {
            chip.classList.add("am-chip--preview");
            const line = document.createElement("span");
            line.className = "am-border-preview";
            line.style.borderTopStyle = borderPreviewStyle(item.value);
            chip.appendChild(line);
        }
        const label = document.createElement("span");
        label.className = "am-chip-label";
        label.textContent = item.label;
        chip.appendChild(label);
        chip.addEventListener("click", () => {
            for (const other of buttons) {
                other.classList.toggle("is-active", other === chip);
            }
            opts.onPick(item.value);
        });
        buttons.push(chip);
        chips.appendChild(chip);
    }

    return popupShell(opts.title, chips, "am-pop--chips");
}

export function buildRangePopup(opts: {
    t: TFn;
    title: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onInput(value: number): void;
}): HTMLElement {
    const body = document.createElement("div");

    const row = document.createElement("div");
    row.className = "am-range-row";

    const range = document.createElement("input");
    range.type = "range";
    range.className = "am-range";
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step ?? 1);
    range.value = String(Math.min(opts.max, Math.max(opts.min, opts.value)));

    const capsule = document.createElement("span");
    capsule.className = "am-capsule";
    capsule.textContent = range.value;

    let pending = Number(range.value);
    let frame = 0;

    range.addEventListener("input", () => {
        pending = Number(range.value);
        capsule.textContent = range.value;
        if (frame !== 0) {
            return;
        }
        frame = window.requestAnimationFrame(() => {
            frame = 0;
            if (!range.isConnected) {
                return;
            }
            opts.onInput(pending);
        });
    });

    row.append(range, capsule);
    body.appendChild(row);

    return popupShell(opts.title, body, "am-pop--range");
}

export function buildShadowPopup(opts: {
    t: TFn;
    value: ShadowState;
    onChange(patch: Partial<ShadowState>): void;
}): HTMLElement {
    const { t, value, onChange } = opts;
    const body = document.createElement("div");

    const switchRow = document.createElement("label");
    switchRow.className = "am-switch-row";
    const switchLabel = document.createElement("span");
    switchLabel.textContent = t("shadow.enabled");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = value.enabled;
    toggle.setAttribute("aria-label", t("shadow.enabled"));
    const track = document.createElement("i");
    track.className = "am-switch";
    toggle.addEventListener("change", () => {
        onChange({ enabled: toggle.checked });
    });
    switchRow.append(switchLabel, toggle, track);
    body.appendChild(switchRow);

    const colorField = document.createElement("div");
    colorField.className = "am-field";
    const colorLabel = document.createElement("div");
    colorLabel.className = "am-field-label";
    colorLabel.textContent = t("shadow.color");
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "am-native-color am-native-color--wide";
    colorInput.setAttribute("aria-label", t("shadow.color"));
    colorInput.value = toNativeColor(value.color);
    colorInput.addEventListener("input", () => {
        onChange({ color: colorInput.value.toUpperCase() });
    });
    colorField.append(colorLabel, colorInput);
    body.appendChild(colorField);

    function addSlider(
        label: string,
        min: number,
        max: number,
        current: number,
        apply: (next: number) => Partial<ShadowState>
    ): void {
        const field = document.createElement("div");
        field.className = "am-field";

        const labelEl = document.createElement("div");
        labelEl.className = "am-field-label";
        labelEl.textContent = label;

        const row = document.createElement("div");
        row.className = "am-range-row";

        const range = document.createElement("input");
        range.type = "range";
        range.className = "am-range";
        range.min = String(min);
        range.max = String(max);
        range.step = "1";
        range.value = String(current);

        const capsule = document.createElement("span");
        capsule.className = "am-capsule";
        capsule.textContent = String(current);

        range.addEventListener("input", () => {
            const next = Number(range.value);
            capsule.textContent = range.value;
            onChange(apply(next));
        });

        row.append(range, capsule);
        field.append(labelEl, row);
        body.appendChild(field);
    }

    addSlider(t("shadow.blur"), 0, 40, value.blur, (next) => ({ blur: next }));
    addSlider(
        t("shadow.opacity"),
        0,
        100,
        Math.round(value.opacity * 100),
        (next) => ({ opacity: next / 100 })
    );
    addSlider(t("shadow.x"), -30, 30, value.x, (next) => ({ x: next }));
    addSlider(t("shadow.y"), -30, 30, value.y, (next) => ({ y: next }));

    return popupShell(t("popup.shadow"), body, "am-pop--shadow");
}
