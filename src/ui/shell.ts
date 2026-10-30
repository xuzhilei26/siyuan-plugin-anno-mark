/**
 * Editor chrome: floating toolbar stack, both collapsible sidebars, the scrollable
 * canvas stage, the floating bottom bar, the effect overlay and the three overlay
 * layers.
 *
 * This module only owns DOM structure and the sidebar/toolbar/overlay visibility
 * state; the canvas, toolbar, panels and menus are mounted by other modules into
 * the slots exposed through `ShellRefs`.
 */
import "./shell.css";
import type { TFn } from "../types.ts";
import { getIcon } from "./icons.ts";

export interface ShellRefs {
    root: HTMLDivElement;
    stage: HTMLDivElement;
    toolbarStack: HTMLDivElement;
    toolbarSlot: HTMLDivElement;
    optionsSlot: HTMLDivElement;
    leftSidebar: HTMLDivElement;
    leftBody: HTMLDivElement;
    leftBgSection: HTMLDivElement;
    leftTplSection: HTMLDivElement;
    rightSidebar: HTMLDivElement;
    rightBody: HTMLDivElement;
    canvasArea: HTMLDivElement;
    scroll: HTMLDivElement;
    margin: HTMLDivElement;
    preview: HTMLDivElement;
    canvas: HTMLCanvasElement;
    overlay: HTMLDivElement;
    hint: HTMLDivElement;
    bottomSlot: HTMLDivElement;
    fxScrim: HTMLDivElement;
    fxHost: HTMLDivElement;
    fxPanel: HTMLDivElement;
    popupLayer: HTMLDivElement;
    menuLayer: HTMLDivElement;
    toastLayer: HTMLDivElement;
}

export interface ShellApi {
    refs: ShellRefs;
    setSidebarOpen(side: "left" | "right", open: boolean): void;
    isSidebarOpen(side: "left" | "right"): boolean;
    toggleSidebar(side: "left" | "right"): boolean;
    setSidebarTitle(side: "left" | "right", title: string): void;
    setLeftSection(section: LeftSection): void;
    getLeftSection(): LeftSection;
    setFxOpen(open: boolean): void;
    isFxOpen(): boolean;
    toggleToolbar(visible?: boolean): void;
    isToolbarVisible(): boolean;
    setHint(text: string | null): void;
    destroy(): void;
}

/** Optional shell hooks used by the editor to keep toolbar state in sync. */
export interface ShellHooks {
    onChromeChange?(): void;
}

type Side = "left" | "right";
export type LeftSection = "bg" | "tpl";

/** Keep in sync with the close transition in `shell.css`. */
const FX_ANIMATION_MS = 180;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    return node;
}

export function mountShell(
    container: HTMLElement,
    t: TFn,
    hooks: ShellHooks = {}
): ShellApi {
    const root = el("div", "am-shell");
    const stage = el("div", "am-stage");

    const openState: Record<Side, boolean> = { left: false, right: false };
    const sidebarTitles: Record<Side, HTMLSpanElement> = {} as Record<Side, HTMLSpanElement>;

    interface SidebarParts {
        sidebar: HTMLDivElement;
        body: HTMLDivElement;
    }

    function buildSidebar(side: Side): SidebarParts {
        const sidebar = el(
            "div",
            `am-sidebar am-sidebar--${side}${openState[side] ? " is-open" : ""}`
        );
        const inner = el("div", "am-sidebar-inner");
        const head = el("div", "am-sidebar-head");
        const title = el("span", "am-sidebar-title");
        const close = document.createElement("button");
        close.type = "button";
        close.className = "am-btn am-icon-btn am-sidebar-close";
        close.title = t("common.close");
        close.setAttribute("aria-label", t("common.close"));
        close.innerHTML = getIcon("close");
        close.addEventListener("click", () => setSidebarOpen(side, false));
        head.append(title, close);
        inner.appendChild(head);
        sidebar.appendChild(inner);
        sidebarTitles[side] = title;
        return { sidebar, body: inner };
    }

    const leftParts = buildSidebar("left");
    const rightParts = buildSidebar("right");
    const leftSidebar = leftParts.sidebar;
    const rightSidebar = rightParts.sidebar;
    const leftBody = leftParts.body;
    const rightBody = rightParts.body;

    // The left sidebar hosts exactly one section at a time: background settings
    // or the saved style templates. Both stay mounted; only `hidden` toggles.
    const leftBgSection = el("div", "am-sidebar-section am-sidebar-section--bg");
    const leftTplSection = el("div", "am-sidebar-section am-sidebar-section--tpl");
    leftTplSection.hidden = true;
    leftBody.append(leftBgSection, leftTplSection);

    const canvasArea = el("div", "am-canvas-area");
    const scroll = el("div", "am-canvas-scroll");
    const margin = el("div", "am-canvas-margin");
    const preview = el("div", "am-preview");
    const canvas = el("canvas", "am-canvas");
    const overlay = el("div", "am-overlay");
    preview.append(canvas, overlay);
    margin.appendChild(preview);
    scroll.appendChild(margin);

    const hint = el("div", "am-canvas-hint");
    hint.setAttribute("role", "status");
    canvasArea.append(scroll, hint);

    stage.append(leftSidebar, canvasArea, rightSidebar);

    const toolbarStack = el("div", "am-toolbar-stack");
    const toolbarSlot = el("div", "am-toolbar-slot");
    const optionsSlot = el("div", "am-options-slot");
    toolbarStack.append(toolbarSlot, optionsSlot);

    const bottomSlot = el("div", "am-bottom-slot");

    // Effects overlay: a full-shell scrim plus a fixed, top-centred panel host.
    // `fxPanel` is the inner mount point for the effect browser (Task 2).
    const fxScrim = el("div", "am-fx-scrim");
    fxScrim.hidden = true;
    const fxHost = el("div", "am-fx-host");
    fxHost.hidden = true;
    fxHost.setAttribute("role", "dialog");
    fxHost.setAttribute("aria-modal", "true");
    fxHost.setAttribute("aria-label", t("effects.title"));
    const fxPanel = el("div", "am-fx-panel");
    fxHost.appendChild(fxPanel);
    const onScrimClick = (): void => setFxOpen(false);
    fxScrim.addEventListener("click", onScrimClick);

    const popupLayer = el("div", "am-popup-layer");
    const menuLayer = el("div", "am-menu-layer");
    const toastLayer = el("div", "am-toast-layer");

    root.append(
        stage,
        toolbarStack,
        bottomSlot,
        fxScrim,
        fxHost,
        popupLayer,
        menuLayer,
        toastLayer
    );
    container.appendChild(root);

    const refs: ShellRefs = {
        root,
        stage,
        toolbarStack,
        toolbarSlot,
        optionsSlot,
        leftSidebar,
        leftBody,
        leftBgSection,
        leftTplSection,
        rightSidebar,
        rightBody,
        canvasArea,
        scroll,
        margin,
        preview,
        canvas,
        overlay,
        hint,
        bottomSlot,
        fxScrim,
        fxHost,
        fxPanel,
        popupLayer,
        menuLayer,
        toastLayer,
    };

    let destroyed = false;
    let leftSection: LeftSection = "bg";
    let fxOpen = false;
    let fxCloseTimer: number | null = null;

    function sidebarOf(side: Side): HTMLDivElement {
        return side === "left" ? leftSidebar : rightSidebar;
    }

    function setSidebarOpen(side: Side, open: boolean): void {
        if (destroyed) {
            return;
        }
        openState[side] = open;
        sidebarOf(side).classList.toggle("is-open", open);
        hooks.onChromeChange?.();
    }

    function isSidebarOpen(side: Side): boolean {
        return openState[side];
    }

    function toggleSidebar(side: Side): boolean {
        const next = !openState[side];
        setSidebarOpen(side, next);
        return next;
    }

    function setSidebarTitle(side: Side, title: string): void {
        if (destroyed) {
            return;
        }
        sidebarTitles[side].textContent = title;
    }

    /** Shows one left-sidebar section and refreshes the sidebar heading. */
    function setLeftSection(section: LeftSection): void {
        if (destroyed) {
            return;
        }
        leftSection = section;
        leftBgSection.hidden = section !== "bg";
        leftTplSection.hidden = section !== "tpl";
        setSidebarTitle(
            "left",
            t(section === "bg" ? "panel.background" : "panel.templates")
        );
        hooks.onChromeChange?.();
    }

    function getLeftSection(): LeftSection {
        return leftSection;
    }

    /** Opens or closes the effects overlay and locks canvas scrolling. */
    function setFxOpen(open: boolean): void {
        if (destroyed) {
            return;
        }
        if (fxCloseTimer !== null) {
            window.clearTimeout(fxCloseTimer);
            fxCloseTimer = null;
        }
        fxOpen = open;
        if (open) {
            fxScrim.hidden = false;
            fxHost.hidden = false;
            fxScrim.classList.remove("is-closing");
            fxHost.classList.remove("is-closing");
            fxScrim.classList.add("is-open");
            fxHost.classList.add("is-open");
            root.classList.add("is-fx-open");
        } else {
            fxScrim.classList.remove("is-open");
            fxHost.classList.remove("is-open");
            fxScrim.classList.add("is-closing");
            fxHost.classList.add("is-closing");
            root.classList.remove("is-fx-open");
            fxCloseTimer = window.setTimeout(() => {
                fxCloseTimer = null;
                if (!fxOpen) {
                    fxScrim.hidden = true;
                    fxHost.hidden = true;
                }
            }, FX_ANIMATION_MS);
        }
        hooks.onChromeChange?.();
    }

    function isFxOpen(): boolean {
        return fxOpen;
    }

    function toggleToolbar(visible?: boolean): void {
        if (destroyed) {
            return;
        }
        const next =
            typeof visible === "boolean"
                ? visible
                : toolbarStack.classList.contains("is-hidden");
        toolbarStack.classList.toggle("is-hidden", !next);
    }

    function isToolbarVisible(): boolean {
        return !toolbarStack.classList.contains("is-hidden");
    }

    function setHint(text: string | null): void {
        if (destroyed) {
            return;
        }
        hint.textContent = text ?? "";
    }

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        if (fxCloseTimer !== null) {
            window.clearTimeout(fxCloseTimer);
            fxCloseTimer = null;
        }
        fxScrim.removeEventListener("click", onScrimClick);
        container.replaceChildren();
    }

    return {
        refs,
        setSidebarOpen,
        isSidebarOpen,
        toggleSidebar,
        setSidebarTitle,
        setLeftSection,
        getLeftSection,
        setFxOpen,
        isFxOpen,
        toggleToolbar,
        isToolbarVisible,
        setHint,
        destroy,
    };
}
