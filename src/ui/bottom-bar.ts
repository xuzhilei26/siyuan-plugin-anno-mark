/**
 * Floating bottom command bar.
 *
 * Layout mirrors the prototype from left to right: zoom trigger with a level
 * popup, undo/redo, cancel (red), continue (green circle), copy, save, save-as,
 * pin, print, upload. Pin and upload are unavailable in SiYuan and stay
 * disabled with an explanatory title. The bar only emits commands; every
 * command is interpreted by the editor or by `src/index.ts`.
 */
import "./bottom-bar.css";
import { getIcon, iconButton } from "./icons.ts";
import { mountPopupLayer } from "./popup.ts";
import type { TFn } from "../types.ts";

export interface BottomBarState {
    zoom: number;
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface BottomBarOptions {
    t: TFn;
    onCommand(cmd: string, value?: number): void;
}

export interface BottomBarApi {
    element: HTMLElement;
    sync(state: BottomBarState): void;
    destroy(): void;
}

/** Levels offered by the zoom popup, matching the spec (25%–400%). */
const ZOOM_LEVELS: number[] = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

function makeDivider(): HTMLSpanElement {
    const divider = document.createElement("span");
    divider.className = "am-divider";
    return divider;
}

export function mountBottomBar(
    container: HTMLElement,
    options: BottomBarOptions
): BottomBarApi {
    const { t, onCommand } = options;
    let state: BottomBarState = {
        zoom: 1,
        dirty: false,
        canUndo: false,
        canRedo: false,
    };

    const element = document.createElement("div");
    element.className = "am-bottom-bar";
    element.setAttribute("role", "toolbar");

    // ---- zoom ----
    const zoomBtn = document.createElement("button");
    zoomBtn.type = "button";
    zoomBtn.className = "am-btn am-bottom-zoom";
    zoomBtn.title = t("bottom.zoom");
    zoomBtn.setAttribute("aria-label", t("bottom.zoom"));

    const zoomIcon = document.createElement("span");
    zoomIcon.className = "am-bottom-zoom-icon";
    zoomIcon.innerHTML = getIcon("zoom");

    const zoomValue = document.createElement("span");
    zoomValue.className = "am-bottom-zoom-value";
    zoomValue.textContent = "100%";

    const zoomChevron = document.createElement("span");
    zoomChevron.className = "am-bottom-zoom-chevron";
    zoomChevron.innerHTML = getIcon("chevron-down");

    zoomBtn.append(zoomIcon, zoomValue, zoomChevron);

    // ---- undo / redo ----
    const undoBtn = iconButton("undo", t("ctx.undo"), "am-bottom-undo");
    const redoBtn = iconButton("redo", t("ctx.redo"), "am-bottom-redo");

    // ---- task group ----
    const cancelBtn = iconButton("close", t("bottom.cancel"), "am-bottom-cancel");
    const continueBtn = iconButton("check", t("bottom.continue"), "am-bottom-continue");
    const taskGroup = document.createElement("div");
    taskGroup.className = "am-bottom-group am-bottom-task";
    taskGroup.append(cancelBtn, continueBtn);

    // ---- file commands ----
    const copyBtn = iconButton("copy", t("bottom.copy"), "am-bottom-copy");
    const saveBtn = iconButton("save", t("bottom.save"), "am-bottom-save");
    const saveAsBtn = iconButton("save-as", t("bottom.saveAs"), "am-bottom-save-as");
    const pinBtn = iconButton("pin", t("bottom.pin"), "am-bottom-pin");
    const printBtn = iconButton("print", t("bottom.print"), "am-bottom-print");
    const uploadBtn = iconButton("upload", t("bottom.upload"), "am-bottom-upload");

    pinBtn.disabled = true;
    pinBtn.title = t("msg.pinUnavailable");
    pinBtn.setAttribute("aria-label", t("msg.pinUnavailable"));

    uploadBtn.disabled = true;
    uploadBtn.title = t("msg.uploadUnavailable");
    uploadBtn.setAttribute("aria-label", t("msg.uploadUnavailable"));

    element.append(
        zoomBtn,
        undoBtn,
        redoBtn,
        makeDivider(),
        taskGroup,
        copyBtn,
        saveBtn,
        saveAsBtn,
        pinBtn,
        printBtn,
        uploadBtn
    );
    container.appendChild(element);

    // ---- popup layer (fixed, so the dialog never clips it) ----
    const popupLayer = document.createElement("div");
    popupLayer.className = "am-bottom-popup-layer";
    document.body.appendChild(popupLayer);
    const popup = mountPopupLayer(popupLayer);

    function buildZoomMenu(current: number): HTMLElement {
        const menu = document.createElement("div");
        menu.className = "am-menu am-zoom-menu";

        for (const level of ZOOM_LEVELS) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "am-menu-item";
            if (Math.abs(current - level) < 0.001) {
                item.classList.add("is-active");
            }
            const label = document.createElement("span");
            label.textContent = `${Math.round(level * 100)}%`;
            item.appendChild(label);
            item.addEventListener("click", () => {
                popup.close();
                onCommand("zoom", level);
            });
            menu.appendChild(item);
        }

        const separator = document.createElement("div");
        separator.className = "am-menu-sep";

        const custom = document.createElement("div");
        custom.className = "am-zoom-custom";

        const customInput = document.createElement("input");
        customInput.type = "number";
        customInput.className = "am-zoom-input";
        customInput.min = "10";
        customInput.max = "800";
        customInput.step = "1";
        customInput.value = String(Math.round(current * 100));
        customInput.setAttribute("aria-label", t("bottom.zoomPercent"));

        const percent = document.createElement("span");
        percent.className = "am-zoom-percent";
        percent.textContent = "%";

        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "am-btn am-zoom-apply";
        apply.textContent = t("bottom.zoomApply");

        const applyCustom = (): void => {
            const value = Number(customInput.value);
            if (!Number.isFinite(value) || value <= 0) {
                return;
            }
            popup.close();
            onCommand("zoom", value / 100);
        };

        apply.addEventListener("click", applyCustom);
        customInput.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") {
                return;
            }
            event.preventDefault();
            applyCustom();
        });
        customInput.addEventListener("focus", () => customInput.select());

        custom.append(customInput, percent, apply);

        const fit = document.createElement("button");
        fit.type = "button";
        fit.className = "am-menu-item";
        const fitLabel = document.createElement("span");
        fitLabel.textContent = t("bottom.fit");
        fit.appendChild(fitLabel);
        fit.addEventListener("click", () => {
            popup.close();
            onCommand("fit");
        });

        menu.append(separator, custom, fit);
        return menu;
    }

    const onClickZoom = (): void => {
        popup.open(zoomBtn, buildZoomMenu(state.zoom), { className: "am-zoom-pop" });
    };

    cancelBtn.addEventListener("click", () => onCommand("cancel"));
    continueBtn.addEventListener("click", () => onCommand("continue"));
    undoBtn.addEventListener("click", () => onCommand("undo"));
    redoBtn.addEventListener("click", () => onCommand("redo"));
    copyBtn.addEventListener("click", () => onCommand("copy"));
    saveBtn.addEventListener("click", () => onCommand("save"));
    saveAsBtn.addEventListener("click", () => onCommand("saveAs"));
    printBtn.addEventListener("click", () => onCommand("print"));
    zoomBtn.addEventListener("click", onClickZoom);

    let destroyed = false;

    function sync(next: BottomBarState): void {
        if (destroyed) {
            return;
        }
        state = {
            zoom: next.zoom,
            dirty: next.dirty,
            canUndo: next.canUndo,
            canRedo: next.canRedo,
        };
        zoomValue.textContent = `${Math.round(next.zoom * 100)}%`;
        saveBtn.classList.toggle("is-dirty", next.dirty);
        continueBtn.classList.toggle("is-dirty", next.dirty);
        undoBtn.disabled = !next.canUndo;
        redoBtn.disabled = !next.canRedo;
    }

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        popup.destroy();
        popupLayer.remove();
        element.remove();
    }

    return { element, sync, destroy };
}
