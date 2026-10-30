/**
 * Parameter editor for a single image effect.
 *
 * Renders one control per `EffectParamDef`:
 *   number → range + number input, color → native picker + hex (+ alpha when the
 *   default uses 8 digits), bool → toggle, enum → select, text → text input,
 *   file → picker that stores a data URL.
 *
 * Every edit writes into a local draft and reports it through `onChange`
 * (debounced by 60 ms); Apply commits the draft, Cancel reverts it. Closing the
 * popup from the outside (Escape / outside click on the anchored layer) is
 * treated as Cancel.
 *
 * Compact effects (≤ 6 parameters and an estimated height below 60 % of the
 * viewport) use the shared anchored popup layer. Everything else opens a
 * centered modal overlay appended to `document.body`.
 */
import "./effect-param-popup.css";
import { normalizeParamValue } from "../effects/catalog.ts";
import type {
    EffectDef,
    EffectParamDef,
    ParamDict,
} from "../effects/types.ts";
import type { TFn } from "../types.ts";
import { getIcon } from "./icons.ts";
import type { PopupApi } from "./popup.ts";

export interface EffectParamPopupOptions {
    t: TFn;
    def: EffectDef;
    params: ParamDict;
    anchor: HTMLElement;
    popup: PopupApi;
    /** live draft; called on every edit (debounce ~60ms internally) */
    onChange(params: ParamDict): void;
    /** confirm: commit to history */
    onApply(params: ParamDict): void;
    /** cancel/escape: revert preview */
    onCancel(): void;
}

export interface EffectParamPopupApi {
    close(): void;
    /** external refresh of the values (e.g. after undo) */
    update(params: ParamDict): void;
    isOpen(): boolean;
}

type Cleanup = () => void;
type CloseAction = "apply" | "cancel" | null;

const DEBOUNCE_MS = 120;
const POPUP_MAX_PARAMS = 6;
/** Rough chrome height of the header, padding and footer, in px. */
const CHROME_HEIGHT = 120;
const FIELD_GAP = 10;

function fieldHeight(param: EffectParamDef): number {
    switch (param.type) {
        case "bool":
            return 32;
        case "enum":
            return 54;
        case "color":
            return hasAlphaDefault(param) ? 84 : 54;
        case "file":
            return 54;
        default:
            return 52;
    }
}

function estimatedHeight(def: EffectDef): number {
    const fields = def.params.reduce((sum, param) => sum + fieldHeight(param), 0);
    const gaps = Math.max(0, def.params.length - 1) * FIELD_GAP;
    return CHROME_HEIGHT + fields + gaps;
}

function hasAlphaDefault(param: EffectParamDef): boolean {
    return /^#[0-9a-f]{8}$/i.test(String(param.default));
}

/** Uppercase `#rgb` / `#rrggbb` / `#rrggbbaa`, or `null` when unusable. */
function normalizeColor(raw: string): string | null {
    const value = raw.trim();
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        const digits = value.slice(1).split("");
        return `#${digits.map((digit) => digit + digit).join("")}`.toUpperCase();
    }
    if (/^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{8}$/i.test(value)) {
        return value.toUpperCase();
    }
    return null;
}

function alphaHex(alpha: number): string {
    const clamped = Math.max(0, Math.min(255, Math.round(alpha)));
    return clamped.toString(16).padStart(2, "0").toUpperCase();
}

function colorParts(value: string): { rgb: string; alpha: number; hasAlpha: boolean } {
    const normalized = normalizeColor(value) ?? "#000000";
    if (normalized.length === 9) {
        return {
            rgb: normalized.slice(0, 7),
            alpha: Number.parseInt(normalized.slice(7), 16),
            hasAlpha: true,
        };
    }
    return { rgb: normalized, alpha: 255, hasAlpha: false };
}

function readAsDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
        reader.addEventListener("error", () =>
            reject(reader.error ?? new Error("effect file read failed"))
        );
        reader.readAsDataURL(file);
    });
}

export function openEffectParamPopup(
    options: EffectParamPopupOptions
): EffectParamPopupApi {
    const { t, def, popup } = options;

    const draft: ParamDict = {};
    for (const param of def.params) {
        draft[param.key] = normalizeParamValue(
            param,
            Object.prototype.hasOwnProperty.call(options.params, param.key)
                ? options.params[param.key]
                : param.default
        );
    }

    const cleanups: Cleanup[] = [];
    const refreshers: Array<() => void> = [];
    let timer = 0;
    let closed = false;
    let overlay: HTMLDivElement | null = null;

    const isModal =
        def.params.length > POPUP_MAX_PARAMS ||
        estimatedHeight(def) >= window.innerHeight * 0.6;

    const root = document.createElement("div");
    root.className = isModal ? "am-ep am-ep--modal" : "am-ep am-ep--popup";

    function bind(
        target: EventTarget,
        type: string,
        handler: (event: Event) => void
    ): void {
        target.addEventListener(type, handler);
        cleanups.push(() => target.removeEventListener(type, handler));
    }

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

    function displayName(): string {
        const text = t(def.labelKey);
        return text === def.labelKey ? def.name : text;
    }

    function paramLabel(param: EffectParamDef): string {
        const key = `effect.param.${param.key}`;
        const text = t(key);
        return text === key ? param.label : text;
    }

    function schedule(): void {
        if (closed) {
            return;
        }
        if (timer !== 0) {
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
            timer = 0;
            if (!closed) {
                options.onChange({ ...draft });
            }
        }, DEBOUNCE_MS);
    }

    function setValue(param: EffectParamDef, value: unknown): void {
        draft[param.key] = normalizeParamValue(param, value);
        schedule();
    }

    // ---- Header ------------------------------------------------------------
    const head = document.createElement("div");
    head.className = "am-ep-head";

    const icon = document.createElement("span");
    icon.className = "am-ep-icon";
    icon.innerHTML = getIcon(def.id);

    const titles = document.createElement("div");
    titles.className = "am-ep-titles";
    const titleEl = document.createElement("div");
    titleEl.className = "am-ep-title";
    titleEl.textContent = displayName();
    titleEl.title = def.name;
    const hintEl = document.createElement("div");
    hintEl.className = "am-ep-hint";
    hintEl.textContent = `${tr(
        "effect.params.orderHint",
        "Applied in stack order"
    )} · ${def.params.length} ${tr("effect.params.count", "params")}`;
    titles.append(titleEl, hintEl);

    const resetLabel = tr("effect.params.reset", "Reset to defaults");
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "am-btn am-icon-btn am-ep-reset";
    resetBtn.title = resetLabel;
    resetBtn.setAttribute("aria-label", resetLabel);
    resetBtn.innerHTML = getIcon("refresh-ccw");
    bind(resetBtn, "click", () => {
        for (const param of def.params) {
            draft[param.key] = param.default;
        }
        for (const refresh of refreshers) {
            refresh();
        }
        schedule();
    });

    head.append(icon, titles, resetBtn);

    // ---- Controls ----------------------------------------------------------
    const body = document.createElement("div");
    body.className = "am-ep-body";

    function buildNumber(param: EffectParamDef): HTMLElement {
        const field = document.createElement("div");
        field.className = "am-ep-field";
        field.dataset.key = param.key;

        const label = document.createElement("span");
        label.className = "am-field-label";
        label.textContent = paramLabel(param);

        const row = document.createElement("div");
        row.className = "am-range-row";

        const min = typeof param.min === "number" ? param.min : 0;
        const rawMax = typeof param.max === "number" ? param.max : min + 100;
        const max = rawMax > min ? rawMax : min + 1;
        const step =
            typeof param.step === "number" && param.step > 0
                ? param.step
                : param.integer
                ? 1
                : 0.01;

        const range = document.createElement("input");
        range.type = "range";
        range.className = "am-range";
        range.min = String(min);
        range.max = String(max);
        range.step = String(step);
        range.value = String(Number(draft[param.key]));
        range.setAttribute("aria-label", paramLabel(param));

        const num = document.createElement("input");
        num.type = "number";
        num.className = "am-num";
        num.min = String(min);
        num.max = String(max);
        num.step = String(step);
        num.value = String(Number(draft[param.key]));
        num.setAttribute("aria-label", paramLabel(param));

        bind(range, "input", () => {
            const parsed = Number(range.value);
            if (!Number.isFinite(parsed)) {
                return;
            }
            setValue(param, parsed);
            num.value = String(draft[param.key]);
        });

        bind(num, "input", () => {
            if (num.value.trim() === "") {
                return;
            }
            const parsed = Number(num.value);
            if (!Number.isFinite(parsed)) {
                return;
            }
            setValue(param, parsed);
            range.value = String(draft[param.key]);
        });

        bind(num, "change", () => {
            num.value = String(draft[param.key]);
        });

        refreshers.push(() => {
            const value = String(draft[param.key]);
            range.value = value;
            num.value = value;
        });

        row.append(range, num);
        field.append(label, row);
        return field;
    }

    function buildBool(param: EffectParamDef): HTMLElement {
        const field = document.createElement("div");
        field.className = "am-ep-field";
        field.dataset.key = param.key;

        const row = document.createElement("label");
        row.className = "am-switch-row";
        const label = document.createElement("span");
        label.textContent = paramLabel(param);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(draft[param.key]);
        input.setAttribute("aria-label", paramLabel(param));
        const track = document.createElement("i");
        track.className = "am-switch";
        bind(input, "change", () => {
            setValue(param, input.checked);
        });
        refreshers.push(() => {
            input.checked = Boolean(draft[param.key]);
        });

        row.append(label, input, track);
        field.appendChild(row);
        return field;
    }

    function buildColor(param: EffectParamDef): HTMLElement {
        const field = document.createElement("div");
        field.className = "am-ep-field";
        field.dataset.key = param.key;

        const label = document.createElement("span");
        label.className = "am-field-label";
        label.textContent = paramLabel(param);

        const row = document.createElement("div");
        row.className = "am-ep-color-row";

        const native = document.createElement("input");
        native.type = "color";
        native.className = "am-native-color";
        native.setAttribute("aria-label", paramLabel(param));

        const hex = document.createElement("input");
        hex.type = "text";
        hex.className = "am-hex";
        hex.maxLength = 9;
        hex.spellcheck = false;
        hex.setAttribute("aria-label", paramLabel(param));

        row.append(native, hex);

        const alphaEnabled = hasAlphaDefault(param);
        const alphaInput = alphaEnabled ? document.createElement("input") : null;
        if (alphaInput) {
            alphaInput.type = "number";
            alphaInput.className = "am-num am-ep-alpha";
            alphaInput.min = "0";
            alphaInput.max = "255";
            alphaInput.step = "1";
            alphaInput.setAttribute("aria-label", tr("effect.param.alpha", "Alpha"));
            row.appendChild(alphaInput);
        }

        const commit = (value: string): void => {
            const next = normalizeColor(value);
            if (!next) {
                return;
            }
            draft[param.key] = next;
            const parts = colorParts(next);
            native.value = parts.rgb;
            hex.value = parts.hasAlpha ? `${parts.rgb}${alphaHex(parts.alpha)}` : parts.rgb;
            if (alphaInput) {
                alphaInput.value = String(parts.alpha);
            }
            schedule();
        };

        bind(native, "input", () => {
            const parts = colorParts(String(draft[param.key]));
            commit(native.value + (parts.hasAlpha ? alphaHex(parts.alpha) : ""));
        });

        bind(hex, "input", () => {
            if (normalizeColor(hex.value)) {
                commit(hex.value);
            }
        });

        if (alphaInput) {
            bind(alphaInput, "input", () => {
                if (alphaInput.value.trim() === "") {
                    return;
                }
                const value = Number(alphaInput.value);
                if (!Number.isFinite(value)) {
                    return;
                }
                const parts = colorParts(String(draft[param.key]));
                commit(parts.rgb + alphaHex(value));
            });
        }

        refreshers.push(() => {
            const parts = colorParts(String(draft[param.key]));
            native.value = parts.rgb;
            hex.value = parts.hasAlpha ? `${parts.rgb}${alphaHex(parts.alpha)}` : parts.rgb;
            if (alphaInput) {
                alphaInput.value = String(parts.alpha);
            }
        });

        field.append(label, row);
        return field;
    }

    function buildEnum(param: EffectParamDef): HTMLElement {
        const field = document.createElement("div");
        field.className = "am-ep-field";
        field.dataset.key = param.key;

        const label = document.createElement("span");
        label.className = "am-field-label";
        label.textContent = paramLabel(param);

        const wrap = document.createElement("div");
        wrap.className = "am-select-wrap";
        const select = document.createElement("select");
        select.setAttribute("aria-label", paramLabel(param));
        for (const option of param.options ?? []) {
            const item = document.createElement("option");
            item.value = option.value;
            const key = `effect.enum.${option.value}`;
            const text = t(key);
            item.textContent = text === key ? option.label : text;
            select.appendChild(item);
        }
        select.value = String(draft[param.key]);
        bind(select, "change", () => {
            setValue(param, select.value);
        });
        refreshers.push(() => {
            select.value = String(draft[param.key]);
        });

        wrap.appendChild(select);
        field.append(label, wrap);
        return field;
    }

    function buildText(param: EffectParamDef): HTMLElement {
        const field = document.createElement("div");
        field.className = "am-ep-field";
        field.dataset.key = param.key;

        const label = document.createElement("span");
        label.className = "am-field-label";
        label.textContent = paramLabel(param);

        const input = document.createElement("input");
        input.type = "text";
        input.className = "am-ep-text";
        input.spellcheck = false;
        input.value = String(draft[param.key]);
        input.setAttribute("aria-label", paramLabel(param));

        bind(input, "input", () => {
            setValue(param, input.value);
        });
        refreshers.push(() => {
            input.value = String(draft[param.key]);
        });

        field.append(label, input);
        return field;
    }

    function buildFile(param: EffectParamDef): HTMLElement {
        const field = document.createElement("div");
        field.className = "am-ep-field";
        field.dataset.key = param.key;

        const label = document.createElement("span");
        label.className = "am-field-label";
        label.textContent = paramLabel(param);

        const row = document.createElement("div");
        row.className = "am-ep-file";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "am-ep-btn am-ep-file-btn";

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.hidden = true;
        input.tabIndex = -1;
        input.setAttribute("aria-hidden", "true");

        let chosenName = "";
        const refresh = (): void => {
            const value = String(draft[param.key]);
            const pickLabel = tr("effect.file.pick", "Choose image");
            const selectedLabel =
                value === ""
                    ? ""
                    : chosenName || tr("effect.file.selected", "Image selected");
            btn.textContent = selectedLabel === "" ? pickLabel : selectedLabel;
            btn.title = selectedLabel === "" ? pickLabel : selectedLabel;
            btn.setAttribute("aria-label", btn.title);
        };
        refresh();
        refreshers.push(refresh);

        bind(btn, "click", () => {
            input.value = "";
            input.click();
        });

        bind(input, "change", () => {
            const picked = input.files?.[0];
            if (!picked) {
                return;
            }
            chosenName = picked.name;
            refresh();
            void readAsDataUrl(picked)
                .then((dataUrl) => {
                    if (closed || dataUrl === "") {
                        return;
                    }
                    // The parameter stores the data URL, never a filesystem path.
                    draft[param.key] = dataUrl;
                    schedule();
                })
                .catch(() => {
                    chosenName = "";
                    refresh();
                });
        });

        row.append(btn, input);
        field.append(label, row);
        return field;
    }

    for (const param of def.params) {
        switch (param.type) {
            case "number":
                body.appendChild(buildNumber(param));
                break;
            case "bool":
                body.appendChild(buildBool(param));
                break;
            case "color":
                body.appendChild(buildColor(param));
                break;
            case "enum":
                body.appendChild(buildEnum(param));
                break;
            case "text":
                body.appendChild(buildText(param));
                break;
            case "file":
                body.appendChild(buildFile(param));
                break;
            default:
                break;
        }
    }

    // ---- Footer ------------------------------------------------------------
    const foot = document.createElement("div");
    foot.className = "am-ep-foot";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "am-ep-btn";
    cancelBtn.textContent = tr("effect.params.cancel", "Cancel");

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "am-ep-btn am-ep-btn--primary";
    applyBtn.textContent = tr("effect.params.apply", "Apply");

    bind(cancelBtn, "click", () => finalize("cancel"));
    bind(applyBtn, "click", () => finalize("apply"));

    foot.append(cancelBtn, applyBtn);

    root.append(head, body, foot);

    // ---- Placement ---------------------------------------------------------
    if (isModal) {
        const backdrop = document.createElement("div");
        backdrop.className = "am-effect-modal";

        const panel = document.createElement("div");
        panel.className = "am-effect-modal-panel";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", displayName());
        panel.appendChild(root);
        backdrop.appendChild(panel);

        const onBackdrop = (event: MouseEvent): void => {
            if (event.target === backdrop) {
                finalize("cancel");
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            finalize("cancel");
        };

        backdrop.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKeyDown, true);
        cleanups.push(() => {
            backdrop.removeEventListener("click", onBackdrop);
            document.removeEventListener("keydown", onKeyDown, true);
        });

        overlay = backdrop;
        document.body.appendChild(backdrop);
        const first = body.querySelector<HTMLElement>(
            "input:not([type=file]), select"
        );
        (first ?? applyBtn).focus();
    } else {
        popup.open(options.anchor, root, { className: "am-effect-params" });

        // The shared layer closes on Escape / outside pointer-down; detect the
        // detached content afterwards so those paths still revert the preview.
        const checkExternalClose = (): void => {
            window.setTimeout(() => {
                if (!closed && !root.isConnected) {
                    finalize("cancel");
                }
            }, 0);
        };
        document.addEventListener("pointerdown", checkExternalClose, true);
        document.addEventListener("keydown", checkExternalClose, true);
        cleanups.push(() => {
            document.removeEventListener("pointerdown", checkExternalClose, true);
            document.removeEventListener("keydown", checkExternalClose, true);
        });
    }

    // ---- Lifecycle ---------------------------------------------------------
    function finalize(action: CloseAction): void {
        if (closed) {
            return;
        }
        closed = true;
        if (timer !== 0) {
            window.clearTimeout(timer);
            timer = 0;
        }
        for (const cleanup of cleanups) {
            cleanup();
        }
        cleanups.length = 0;

        if (action === "apply") {
            options.onApply({ ...draft });
        } else if (action === "cancel") {
            options.onCancel();
        }

        if (isModal) {
            overlay?.remove();
            overlay = null;
        } else if (root.isConnected) {
            // Never close a popup the callback may have opened in the meantime.
            popup.close();
        }
    }

    function update(params: ParamDict): void {
        if (closed) {
            return;
        }
        for (const param of def.params) {
            if (Object.prototype.hasOwnProperty.call(params, param.key)) {
                draft[param.key] = normalizeParamValue(param, params[param.key]);
            }
        }
        for (const refresh of refreshers) {
            refresh();
        }
    }

    return {
        close(): void {
            finalize(null);
        },
        update,
        isOpen(): boolean {
            return !closed;
        },
    };
}
