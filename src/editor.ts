/**
 * Editor orchestrator.
 *
 * Owns the editor state (`annotations`, `bg`, `effects`, tool, zoom, history)
 * and wires the shell, toolbar, options bar, side panels, bottom bar and the
 * overlay layers into one document. Rendering is delegated to `canvas.ts`;
 * this module only computes the scene/fit and maps pointer events between
 * screen and image pixel space.
 *
 * Every document mutation funnels through `commit()`: a deep JSON snapshot is
 * pushed onto a 50-entry undo stack, the canvas is re-laid out and every chrome
 * surface is synced. Command strings (`handleCommand`, shortcuts, menus and the
 * bottom bar) all resolve through `runCommand()`.
 */
import "./ui/editor.css";
import {
    annotationBounds,
    compositeToBlob,
    computeScene,
    createMapper,
    cropBaseImage,
    detectAutoCrop,
    fitScreen,
    hitTest,
    loadImageElement,
    renderScene,
} from "./canvas.ts";
import type { Rect, Scene, ScreenFit } from "./canvas.ts";
import {
    createAppliedEffect,
    hasParams,
    sanitizeAppliedEffect,
} from "./effects/catalog.ts";
import type { EffectDef } from "./effects/types.ts";
import type { AppliedEffect, ParamDict } from "./effects/types.ts";
import {
    PREVIEW_MAX_SIDE,
    isRunnable,
    renderEffects,
} from "./effects/engine.ts";
import type { ProcessedBase } from "./effects/engine.ts";
import { migrateEffectState } from "./storage.ts";
import { openEffectParamPopup } from "./ui/effect-param-popup.ts";
import {
    DEFAULT_BG,
    DEFAULT_EFFECTS,
    TOOL_SHORTCUTS,
    createOptions,
} from "./types.ts";
import type {
    Annotation,
    AnnotationType,
    BgState,
    CursorType,
    EffectState,
    Point,
    StyleTemplate,
    TFn,
    ToolId,
    ToolOptions,
} from "./types.ts";
import { mountShell } from "./ui/shell.ts";
import { mountToolbar } from "./ui/toolbar.ts";
import type { ToolbarApi } from "./ui/toolbar.ts";
import { mountOptionsBar } from "./ui/options-bar.ts";
import type { OptionsBarApi } from "./ui/options-bar.ts";
import { mountPopupLayer } from "./ui/popup.ts";
import type { PopupApi } from "./ui/popup.ts";
import { popupShell } from "./ui/popups.ts";
import { mountBackgroundPanel } from "./ui/background-panel.ts";
import type { BackgroundPanelApi } from "./ui/background-panel.ts";
import { mountEffectsPanel } from "./ui/effects-panel.ts";
import type { EffectsPanelApi } from "./ui/effects-panel.ts";
import { mountTemplatesPanel } from "./ui/templates-panel.ts";
import type { TemplatesPanelApi } from "./ui/templates-panel.ts";
import {
    BUILTIN_TEMPLATES,
    createTemplate,
    deleteTemplate,
    loadTemplates,
    saveTemplates,
} from "./ui/templates.ts";
import { mountToast } from "./ui/toast.ts";
import type { ToastApi } from "./ui/toast.ts";
import { mountBottomBar } from "./ui/bottom-bar.ts";
import type { BottomBarApi } from "./ui/bottom-bar.ts";
import { mountContextMenu } from "./ui/context-menu.ts";
import type { ContextMenuApi, ContextMenuItem } from "./ui/context-menu.ts";
import { getIcon } from "./ui/icons.ts";

export interface EditorMountOptions {
    image: HTMLImageElement;
    annotations?: Annotation[];
    bg?: BgState;
    effects?: EffectState;
    initialTool?: ToolId;
    hint?: string;
    t: TFn;
    onSnapshotChange?(snapshot: EditorSnapshot): void;
    onRequestSave(mode: SaveMode): void; // "save" | "saveAs"
    onRequestClose(dirty: boolean): void;
    onRequestCopy(): void;
    onRequestPrint(): void;
}

export interface EditorSnapshot {
    annotations: Annotation[];
    bg: BgState;
    effects: EffectState;
    baseImage: HTMLImageElement;
    baseDirty: boolean;
}

export interface EditorHandle {
    destroy(): void;
    isDirty(): boolean;
    getAnnotations(): Annotation[];
    getSnapshot(): EditorSnapshot;
    getComposite(): Promise<Blob>;
    markSaved(): void;
    handleCommand(command: string, value?: number | string): void;
    /** Consumes one Escape layer; `false` when nothing is left to unwind. */
    handleEscape(): boolean;
    setHint(text: string | null): void;
}

export type SaveMode = "save" | "saveAs";

const HISTORY_LIMIT = 50;
const DRAG_THRESHOLD = 3;
const CROP_MIN_SIZE = 8;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const STEP_SIZE_RATIO = 1.6;
const CURSOR_SIZE = 34;
const EMOJI_BOX = 48;
const EMOJI_LIST = ["✅", "❌", "⭐", "❤️", "🔥", "👍", "👎", "❓", "❗", "💡", "🎉", "🚀"];
const PAN_HOLD_MS = 320;
const PAN_CANCEL = 6;

const DRAG_TOOLS: ToolId[] = [
    "rectangle",
    "ellipse",
    "line",
    "arrow",
    "freehand",
    "highlight",
    "cutout",
    "blur",
    "pixelate",
    "magnify",
    "spotlight",
    "clone",
];

/** Pending timers for the background-field reveal flash; cleared on destroy. */
let fieldFlashTimers: number[] = [];

type DragState =
    | {
          mode: "draw";
          start: Point;
          startOut: Point;
          tool: ToolId;
          moved: boolean;
      }
    | {
          mode: "move";
          id: string;
          origin: Annotation;
          start: Point;
          startOut: Point;
          moved: boolean;
      }
    | { mode: "crop"; startOut: Point; currentOut: Point }
    | { mode: "erase" };

interface TextSession {
    element: HTMLTextAreaElement;
    point: Point;
    out: Point;
    type: "text" | "speech";
}

/** State captured before a long-press pan, used to roll back its draft. */
interface PanGuard {
    json: string;
    historyIndex: number;
    stepCounter: number;
    seedCounter: number;
    dirty: boolean;
}

interface RecentEntry {
    name: string;
    src: string;
}

function clampNumber(value: number, lo: number, hi: number): number {
    if (!Number.isFinite(value)) {
        return lo;
    }
    return Math.min(hi, Math.max(lo, value));
}

function normalizeRotate(rotate: number): number {
    const rounded = Math.round(rotate / 90) * 90;
    return ((rounded % 360) + 360) % 360;
}

export function mountEditor(
    container: HTMLElement,
    opts: EditorMountOptions
): EditorHandle {
    const t = opts.t;

    /* --------------------------------------------------------------- state */

    let annotations: Annotation[] = cloneAnnotations(opts.annotations ?? []);
    let selectedId: string | null = null;
    let tool: ToolId =
        opts.initialTool ?? (annotations.length > 0 ? "select" : "rectangle");
    let toolOptions: ToolOptions = createOptions();
    let bg: BgState = { ...DEFAULT_BG, ...(opts.bg ?? {}) };
    let effects: EffectState = normalizeEffects(opts.effects);
    let baseImage: HTMLImageElement = opts.image;
    let baseDirty = false;
    let zoom = 1;
    let fitMode = true;
    let dirty = false;
    let destroyed = false;

    let history: string[] = [];
    let historyIndex = -1;
    let scene: Scene | null = null;
    let fit: ScreenFit | null = null;
    let temp: Annotation | null = null;
    let drag: DragState | null = null;
    /** Snapshot taken when an erase drag starts; restored on pointercancel. */
    let eraseBackup: Annotation[] | null = null;
    let cropRect: Rect | null = null;
    let cropScreen: Rect | null = null;
    let textSession: TextSession | null = null;
    let stepCounter = toolOptions.stepStart;
    let seedCounter = 1;
    let idCounter = 0;
    let bgImage: CanvasImageSource | null = null;
    let bgImageSrc = "";
    let baseObjectUrl = "";
    let recent: RecentEntry[] = [];
    /** Cached canvas of the original base image (source for the effect engine). */
    let baseCanvas: HTMLCanvasElement | null = null;
    let baseCanvasKey = "";
    /** Preview render of the effect stack (long edge <= PREVIEW_MAX_SIDE). */
    let basePreview: ProcessedBase | null = null;
    /** Live parameter draft: negative index means "not yet in the stack". */
    let draft: { index: number; effect: AppliedEffect } | null = null;
    let templates: StyleTemplate[] = loadTemplates();

    const pan = {
        pending: false,
        active: false,
        spaceDown: false,
        startX: 0,
        startY: 0,
        scrollLeft: 0,
        scrollTop: 0,
        holdX: 0,
        holdY: 0,
        pointerId: -1,
        holdTimer: 0,
        guard: null as PanGuard | null,
    };

    const images = new Map<string, CanvasImageSource>();
    const objectUrls: string[] = [];

    /* -------------------------------------------------------------- modules */

    const shell = mountShell(container, t, {
        onChromeChange() {
            syncChrome();
        },
    });
    const refs = shell.refs;
    const popup: PopupApi = mountPopupLayer(refs.popupLayer);
    const toast: ToastApi = mountToast(refs.toastLayer);
    const contextMenu: ContextMenuApi = mountContextMenu(refs.menuLayer);

    /* ------------------------------------------------- crop overlay markup */

    const cropLayer = document.createElement("div");
    cropLayer.className = "am-crop-layer";
    cropLayer.hidden = true;

    const cropBox = document.createElement("div");
    cropBox.className = "am-crop-box";

    const cropLabel = document.createElement("div");
    cropLabel.className = "am-crop-label";

    cropBox.appendChild(cropLabel);
    cropLayer.appendChild(cropBox);
    refs.overlay.appendChild(cropLayer);

    /* ----------------------------------------------------------- submodules */

    const toolbar: ToolbarApi = mountToolbar(refs.toolbarSlot, {
        t,
        onSelectTool(next) {
            setTool(next);
        },
        onPanelToggle(panel) {
            if (panel === "templates") {
                const open =
                    shell.isSidebarOpen("left") &&
                    shell.getLeftSection() === "tpl";
                if (open) {
                    shell.setSidebarOpen("left", false);
                } else {
                    shell.setLeftSection("tpl");
                    shell.setSidebarOpen("left", true);
                }
                return;
            }
            shell.setFxOpen(!shell.isFxOpen());
        },
        onFileMenu(anchor) {
            openFileMenu(anchor);
        },
    });

    const optionsBar: OptionsBarApi = mountOptionsBar(refs.optionsSlot, {
        t,
        popup,
        onChange(patch) {
            onOptionChange(patch);
        },
    });

    const backgroundPanel: BackgroundPanelApi = mountBackgroundPanel(
        refs.leftBgSection,
        {
            t,
            bg,
            onChange(patch) {
                bg = { ...bg, ...patch };
                commit();
            },
            onPickImage() {
                return pickImageDataUrl();
            },
        }
    );

    const templatesPanel: TemplatesPanelApi = mountTemplatesPanel(
        refs.leftTplSection,
        {
            t,
            onSave(name) {
                saveStyleTemplate(name);
            },
            onApply(tpl) {
                applyStyleTemplate(tpl);
            },
            onDelete(id) {
                removeStyleTemplate(id);
            },
        }
    );

    function templateList(): StyleTemplate[] {
        return [...BUILTIN_TEMPLATES, ...templates];
    }

    function templateLabel(tpl: StyleTemplate): string {
        if (tpl.builtin !== true) {
            return tpl.name;
        }
        const key = `tpl.builtinName.${tpl.id.replace(/^builtin-/, "")}`;
        const text = t(key);
        return text === key ? tpl.name : text;
    }

    function saveStyleTemplate(name: string): void {
        if (destroyed) {
            return;
        }
        const selected = selectedAnnotation();
        const styleTool: ToolId = selected
            ? (selected.type as ToolId)
            : tool === "select"
              ? "rectangle"
              : tool;
        const styleOpts = selected ? optionsForChrome(selected) : toolOptions;
        const trimmed = name.trim();
        const finalName =
            trimmed === ""
                ? `${t("tpl.untitled")} ${templates.length + 1}`
                : trimmed;
        templates = [
            ...templates,
            createTemplate(finalName, styleTool, styleOpts, templateList()),
        ];
        saveTemplates(templates);
        templatesPanel.sync(templateList());
        toast.show(
            t("tpl.saved", {
                name: finalName,
                tool: t("tool." + styleTool),
            }),
            "success"
        );
    }

    function applyStyleTemplate(tpl: StyleTemplate): void {
        if (destroyed) {
            return;
        }
        toolOptions = { ...tpl.opts, shadow: { ...tpl.opts.shadow } };
        stepCounter = tpl.opts.stepStart;
        const selected = selectedAnnotation();
        if (selected !== null) {
            if (applyPatchToAnnotation(selected, tpl.opts)) {
                commit();
            } else {
                syncChrome();
                paint();
            }
        } else {
            setTool(tpl.tool);
        }
        toast.show(t("tpl.applied", { name: templateLabel(tpl) }), "success");
    }

    function removeStyleTemplate(id: string): void {
        if (destroyed) {
            return;
        }
        const old = templates.find((tpl) => tpl.id === id);
        const name = old === undefined ? id : templateLabel(old);
        templates = deleteTemplate(id);
        templatesPanel.sync(templateList());
        toast.show(t("tpl.deleted", { name }), "info");
    }

    templatesPanel.sync(templateList());

    const effectsPanel: EffectsPanelApi = mountEffectsPanel(refs.fxPanel, {
        t,
        onApply(def, anchor) {
            applyEffect(def, anchor);
        },
        onClose() {
            shell.setFxOpen(false);
        },
    });

    const bottomBar: BottomBarApi = mountBottomBar(refs.bottomSlot, {
        t,
        onCommand(cmd, value) {
            runCommand(cmd, value);
        },
    });

    /* ------------------------------------------------------------- history */

    history = [snapshotJson()];
    historyIndex = 0;

    /* -------------------------------------------------------------- render */

    function availSize(): { w: number; h: number } {
        const scroll = refs.scroll;
        const style = getComputedStyle(scroll);
        const px = (value: string): number => {
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        };
        const w =
            scroll.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
        const h =
            scroll.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
        return { w: Math.max(40, w), h: Math.max(40, h) };
    }

    /* ------------------------------------------------------------- rendering */

    function baseKey(): string {
        const src = baseImage.src || "";
        const w = baseImage.naturalWidth || baseImage.width || 1;
        const h = baseImage.naturalHeight || baseImage.height || 1;
        return `${w}x${h}:${src.length}:${src.slice(-48)}`;
    }

    /** Original base image as a canvas (the effect engine needs pixels). */
    function getBaseCanvas(): HTMLCanvasElement {
        const key = baseKey();
        if (baseCanvas && baseCanvasKey === key) {
            return baseCanvas;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        canvas.height = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("2d context unavailable");
        }
        ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
        baseCanvas = canvas;
        baseCanvasKey = key;
        return canvas;
    }

    /** Stack shown on screen: the committed stack plus any live draft. */
    function stackForRender(): AppliedEffect[] {
        if (!draft) {
            return effects.stack;
        }
        const list = [...effects.stack];
        if (draft.index < 0) {
            list.push(draft.effect);
        } else {
            list[draft.index] = draft.effect;
        }
        return list;
    }

    function renderBase(maxSide?: number): ProcessedBase {
        return renderEffects(getBaseCanvas(), stackForRender(), {
            baseKey: baseKey(),
            maxSide,
        });
    }

    function relayout(): void {
        if (destroyed) {
            return;
        }
        ensureBgImage();
        const imgW = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        const imgH = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);
        basePreview = renderBase(PREVIEW_MAX_SIDE);
        const scale = basePreview.scale > 0 ? basePreview.scale : 1;
        const pad = {
            top: Math.round(basePreview.pad.top / scale),
            right: Math.round(basePreview.pad.right / scale),
            bottom: Math.round(basePreview.pad.bottom / scale),
            left: Math.round(basePreview.pad.left / scale),
        };
        const next = computeScene(imgW, imgH, bg, effects.rotate, pad);
        if (fitMode) {
            resetStagePadding();
        }
        const avail = availSize();
        const nextFit = fitScreen(
            refs.canvas,
            next,
            avail.w,
            avail.h,
            fitMode ? null : zoom
        );
        updateStagePadding();
        scene = next;
        fit = nextFit;
        refs.preview.style.width = `${nextFit.cssW}px`;
        refs.preview.style.height = `${nextFit.cssH}px`;
        paint();
    }

    function paint(): void {
        if (destroyed || scene === null || fit === null) {
            return;
        }
        const ctx = refs.canvas.getContext("2d");
        if (!ctx) {
            return;
        }
        ctx.setTransform(fit.pixelRatio, 0, 0, fit.pixelRatio, 0, 0);
        const list = temp === null ? annotations : [...annotations, temp];
        renderScene(ctx, scene, {
            image: basePreview ? basePreview.canvas : baseImage,
            bgImage,
            annotations: list,
            effects,
            images,
            selectedId,
            showSelection: tool === "select",
            handleScale: fit.pixelRatio,
        });
        positionCropOverlay();
    }

    function ensureBgImage(): void {
        const src = bg.mode === "image" && bg.imageSrc ? bg.imageSrc : "";
        if (!src) {
            bgImage = null;
            bgImageSrc = "";
            return;
        }
        if (src === bgImageSrc) {
            return;
        }
        bgImageSrc = src;
        bgImage = null;
        loadImageElement(src).then(
            (img) => {
                if (!destroyed && bgImageSrc === src) {
                    bgImage = img;
                    paint();
                }
            },
            () => undefined
        );
    }

    function ensureAnnotationImages(): void {
        for (const annotation of annotations) {
            if (annotation.type !== "image") {
                continue;
            }
            const src = annotation.src;
            if (!src || images.has(annotation.id)) {
                continue;
            }
            const id = annotation.id;
            loadImageElement(src).then(
                (img) => {
                    if (!destroyed) {
                        images.set(id, img);
                        paint();
                    }
                },
                () => undefined
            );
        }
    }

    function optionsForChrome(selected: Annotation | null): ToolOptions {
        if (selected === null) {
            return toolOptions;
        }
        return {
            ...toolOptions,
            stroke: selected.stroke,
            fill: selected.fill,
            textColor: selected.textColor ?? toolOptions.textColor,
            width: selected.width,
            borderStyle: selected.borderStyle,
            corner: selected.corner,
            fontFamily: selected.fontFamily ?? toolOptions.fontFamily,
            fontSize: selected.fontSize ?? toolOptions.fontSize,
            align: selected.align ?? toolOptions.align,
            bold: selected.bold ?? toolOptions.bold,
            italic: selected.italic ?? toolOptions.italic,
            stepType: selected.stepType ?? toolOptions.stepType,
            stepStart: selected.stepValue ?? toolOptions.stepStart,
            strength: selected.strength ?? toolOptions.strength,
            spotlightBlur: selected.spotlightBlur ?? toolOptions.spotlightBlur,
            effectEllipse: selected.effectEllipse ?? toolOptions.effectEllipse,
            tail: selected.tail ?? toolOptions.tail,
            cursorType: selected.cursorType ?? toolOptions.cursorType,
            shadow: selected.shadow ?? toolOptions.shadow,
        };
    }

    function displayZoom(): number {
        const value = fitMode && fit !== null ? fit.screenScale : zoom;
        return clampNumber(value, ZOOM_MIN, ZOOM_MAX);
    }

    function notify(): void {
        opts.onSnapshotChange?.(getSnapshot());
    }

    function syncChrome(): void {
        if (destroyed) {
            return;
        }
        const selected = selectedAnnotation();
        optionsBar.sync({
            tool,
            selected,
            options: optionsForChrome(selected),
        });
        toolbar.setActiveTool(tool);
        toolbar.setPanelOpen(
            "templates",
            shell.isSidebarOpen("left") && shell.getLeftSection() === "tpl"
        );
        toolbar.setPanelOpen("effects", shell.isFxOpen());
        backgroundPanel.sync(bg);
        effectsPanel.sync(effects.stack);
        bottomBar.sync({
            zoom: displayZoom(),
            dirty,
            canUndo: historyIndex > 0,
            canRedo: historyIndex < history.length - 1,
        });
    }

    function relayoutAndRender(): void {
        relayout();
        syncChrome();
    }

    /* -------------------------------------------------------------- snapshot */

    function snapshotJson(): string {
        return JSON.stringify({ annotations, bg, effects });
    }

    function getSnapshot(): EditorSnapshot {
        return {
            annotations: cloneAnnotations(annotations),
            bg: { ...bg },
            effects: normalizeEffects(effects),
            baseImage,
            baseDirty,
        };
    }

    function commit(): void {
        if (destroyed) {
            return;
        }
        const snapshot = snapshotJson();
        if (snapshot !== history[historyIndex]) {
            history = history.slice(0, historyIndex + 1);
            history.push(snapshot);
            if (history.length > HISTORY_LIMIT) {
                history = history.slice(history.length - HISTORY_LIMIT);
            }
            historyIndex = history.length - 1;
            dirty = true;
        }
        // Base-image changes (crop/resize) are outside the history payload, so
        // always re-lay out even when the annotation snapshot is unchanged.
        ensureAnnotationImages();
        relayout();
        syncChrome();
        notify();
    }

    function restore(json: string, markDirty = true): void {
        const parsed = JSON.parse(json) as {
            annotations?: Annotation[];
            bg?: BgState;
            effects?: EffectState;
        };
        annotations = cloneAnnotations(parsed.annotations ?? []);
        bg = { ...DEFAULT_BG, ...(parsed.bg ?? {}) };
        effects = normalizeEffects(parsed.effects);
        temp = null;
        if (
            selectedId !== null &&
            !annotations.some((item) => item.id === selectedId)
        ) {
            selectedId = null;
        }
        if (markDirty) {
            dirty = true;
        }
        ensureAnnotationImages();
        relayoutAndRender();
        notify();
    }

    function undo(): void {
        if (historyIndex <= 0) {
            return;
        }
        historyIndex -= 1;
        restore(history[historyIndex]);
    }

    function redo(): void {
        if (historyIndex >= history.length - 1) {
            return;
        }
        historyIndex += 1;
        restore(history[historyIndex]);
    }

    /* --------------------------------------------------------------- tools */

    function isDragTool(value: ToolId): boolean {
        return DRAG_TOOLS.includes(value);
    }

    function selectedAnnotation(): Annotation | null {
        if (selectedId === null) {
            return null;
        }
        return annotations.find((item) => item.id === selectedId) ?? null;
    }

    function setTool(next: ToolId): void {
        if (destroyed) {
            return;
        }
        if (textSession !== null) {
            commitTextEditor();
        }
        if (next !== "crop") {
            if (cropRect !== null) {
                shell.setHint(opts.hint ?? null);
            }
            clearCropState();
        }
        temp = null;
        drag = null;
        eraseBackup = null;
        tool = next;
        if (next !== "select") {
            selectedId = null;
        }
        updateCursor();
        toolbar.setActiveTool(tool);
        syncChrome();
        paint();
    }

    function updateCursor(): void {
        const cursor =
            tool === "select"
                ? "grab"
                : tool === "text" || tool === "speech"
                  ? "text"
                  : "crosshair";
        refs.canvas.style.cursor = cursor;
    }

    /* -------------------------------------------------------- annotations */

    function nextId(): string {
        idCounter += 1;
        return `a${Date.now().toString(36)}${idCounter.toString(36)}`;
    }

    function createAnnotation(
        type: AnnotationType,
        start: Point,
        end: Point
    ): Annotation {
        const base = {
            id: nextId(),
            type,
            stroke: toolOptions.stroke,
            fill: toolOptions.fill,
            textColor: toolOptions.textColor,
            width: toolOptions.width,
            borderStyle: toolOptions.borderStyle,
            corner: toolOptions.corner,
            shadow: { ...toolOptions.shadow },
            x1: start[0],
            y1: start[1],
            x2: end[0],
            y2: end[1],
            fontFamily: toolOptions.fontFamily,
            fontSize: toolOptions.fontSize,
            align: toolOptions.align,
            bold: toolOptions.bold,
            italic: toolOptions.italic,
            stepType: toolOptions.stepType,
            strength: toolOptions.strength,
            spotlightBlur: toolOptions.spotlightBlur,
            effectEllipse: toolOptions.effectEllipse,
            tail: toolOptions.tail,
            cursorType: toolOptions.cursorType,
        };
        return base as unknown as Annotation;
    }

    function deleteSelected(): void {
        const selected = selectedAnnotation();
        if (selected === null) {
            return;
        }
        annotations = annotations.filter((item) => item.id !== selected.id);
        selectedId = null;
        commit();
    }

    /** Removes the topmost annotation under an image-space point. */
    function eraseAt(point: Point): boolean {
        const ctx = refs.canvas.getContext("2d") ?? undefined;
        const hit = hitTest(annotations, point[0], point[1], ctx);
        if (hit === null) {
            return false;
        }
        annotations = annotations.filter((item) => item.id !== hit.id);
        images.delete(hit.id);
        if (selectedId === hit.id) {
            selectedId = null;
        }
        paint();
        return true;
    }

    function clearAnnotations(): void {
        if (annotations.length === 0) {
            return;
        }
        annotations = [];
        selectedId = null;
        temp = null;
        commit();
    }

    function duplicateSelected(): void {
        const selected = selectedAnnotation();
        if (selected === null) {
            return;
        }
        const copy = cloneAnnotation(selected);
        copy.id = nextId();
        const offset = 16;
        copy.x1 += offset;
        copy.x2 += offset;
        copy.y1 += offset;
        copy.y2 += offset;
        if (copy.points) {
            copy.points = copy.points.map(([x, y]) => [
                x + offset,
                y + offset,
            ]);
        }
        const image = images.get(selected.id);
        if (image) {
            images.set(copy.id, image);
        }
        annotations.push(copy);
        selectedId = copy.id;
        commit();
    }

    async function copyAnnotationsToClipboard(): Promise<void> {
        const selected = selectedAnnotation();
        const list = selected === null ? annotations : [selected];
        if (list.length === 0) {
            toast.show(t("msg.noSelection"), "info");
            return;
        }
        try {
            if (!navigator.clipboard) {
                throw new Error("clipboard unavailable");
            }
            await navigator.clipboard.writeText(JSON.stringify(list));
            toast.show(t("msg.copied"), "success");
        } catch {
            toast.show(t("msg.copyFailed"), "error");
        }
    }

    function cutSelected(): void {
        const selected = selectedAnnotation();
        if (selected === null) {
            return;
        }
        void copyAnnotationsToClipboard();
        deleteSelected();
    }

    function offsetAnnotations(dx: number, dy: number): void {
        for (const annotation of annotations) {
            annotation.x1 += dx;
            annotation.x2 += dx;
            annotation.y1 += dy;
            annotation.y2 += dy;
            if (annotation.points) {
                annotation.points = annotation.points.map(([x, y]) => [
                    x + dx,
                    y + dy,
                ]);
            }
            if (typeof annotation.srcX === "number") {
                annotation.srcX += dx;
            }
            if (typeof annotation.srcY === "number") {
                annotation.srcY += dy;
            }
        }
    }

    function scaleAnnotations(sx: number, sy: number): void {
        for (const annotation of annotations) {
            annotation.x1 *= sx;
            annotation.x2 *= sx;
            annotation.y1 *= sy;
            annotation.y2 *= sy;
            if (annotation.points) {
                annotation.points = annotation.points.map(([x, y]) => [
                    x * sx,
                    y * sy,
                ]);
            }
            if (typeof annotation.srcX === "number") {
                annotation.srcX *= sx;
            }
            if (typeof annotation.srcY === "number") {
                annotation.srcY *= sy;
            }
        }
    }

    /* ------------------------------------------------------ option changes */

    function onOptionChange(patch: Partial<ToolOptions>): void {
        if (destroyed) {
            return;
        }
        const selected = selectedAnnotation();
        if (tool === "select" && selected !== null) {
            if (applyPatchToAnnotation(selected, patch)) {
                commit();
            }
            return;
        }
        toolOptions = { ...toolOptions, ...patch };
        if (patch.stepStart !== undefined) {
            stepCounter = patch.stepStart;
        }
        syncChrome();
    }

    function applyPatchToAnnotation(
        annotation: Annotation,
        patch: Partial<ToolOptions>
    ): boolean {
        const target = annotation as unknown as Record<string, unknown>;
        let changed = false;
        for (const key of Object.keys(patch) as Array<keyof ToolOptions>) {
            const value = patch[key];
            if (value === undefined) {
                continue;
            }
            const field = key === "stepStart" ? "stepValue" : key;
            if (JSON.stringify(target[field]) === JSON.stringify(value)) {
                continue;
            }
            target[field] = value;
            changed = true;
        }
        return changed;
    }

    /* ---------------------------------------------------------- background */

    async function pickImageFile(): Promise<File | null> {
        return new Promise<File | null>((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.className = "am-editor-file";
            refs.root.appendChild(input);

            let settled = false;
            const finish = (file: File | null): void => {
                if (settled) {
                    return;
                }
                settled = true;
                input.remove();
                resolve(file);
            };

            input.addEventListener("change", () => {
                finish(input.files && input.files.length > 0 ? input.files[0] : null);
            });
            input.addEventListener("cancel", () => finish(null));
            input.click();
        });
    }

    function readFileAsDataUrl(file: File): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                if (typeof result === "string") {
                    resolve(result);
                } else {
                    reject(new Error("read failed"));
                }
            };
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(file);
        });
    }

    async function pickImageDataUrl(): Promise<string | null> {
        const file = await pickImageFile();
        if (file === null) {
            return null;
        }
        return readFileAsDataUrl(file);
    }

    function releaseBlobUrl(src: string): void {
        if (!src.startsWith("blob:")) {
            return;
        }
        try {
            URL.revokeObjectURL(src);
        } catch {
            // Already revoked / invalid URL: nothing to clean up.
        }
    }

    function adoptBaseImage(image: HTMLImageElement): void {
        if (baseObjectUrl && baseObjectUrl !== image.src) {
            releaseBlobUrl(baseObjectUrl);
        }
        baseImage = image;
        baseObjectUrl = image.src.startsWith("blob:") ? image.src : "";
    }

    function setBaseImage(image: HTMLImageElement, markDirty: boolean): void {
        adoptBaseImage(image);
        if (markDirty) {
            baseDirty = true;
            dirty = true;
        }
        relayoutAndRender();
        notify();
    }

    function pushRecent(name: string, src: string): void {
        recent = [
            { name, src },
            ...recent.filter((entry) => entry.name !== name || entry.src !== src),
        ].slice(0, 5);
    }

    /* ------------------------------------------------------------- pointer */

    function canvasOut(event: PointerEvent): Point | null {
        if (scene === null) {
            return null;
        }
        const rect = refs.canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        return [
            ((event.clientX - rect.left) / rect.width) * scene.outW,
            ((event.clientY - rect.top) / rect.height) * scene.outH,
        ];
    }

    function toImage(out: Point): Point {
        if (scene === null) {
            return out;
        }
        const mapper = createMapper(scene, effects);
        const point = mapper(out[0], out[1]);
        return [point.x, point.y];
    }

    /* ------------------------------------------------------------- panning */

    function clearHoldTimer(): void {
        if (pan.holdTimer !== 0) {
            window.clearTimeout(pan.holdTimer);
            pan.holdTimer = 0;
        }
        pan.pending = false;
        pan.guard = null;
    }

    function beginPan(x: number, y: number, pointerId: number): void {
        if (pan.active) {
            return;
        }
        pan.startX = x;
        pan.startY = y;
        pan.scrollLeft = refs.scroll.scrollLeft;
        pan.scrollTop = refs.scroll.scrollTop;
        pan.pointerId = pointerId;
        pan.active = true;
        refs.scroll.classList.add("is-panning");
        refs.scroll.classList.remove("is-pan-ready");
    }

    function endPan(): void {
        if (!pan.active) {
            return;
        }
        pan.active = false;
        pan.pointerId = -1;
        refs.scroll.classList.remove("is-panning");
        if (pan.spaceDown) {
            refs.scroll.classList.add("is-pan-ready");
        }
    }

    function scheduleLongPress(event: PointerEvent, guard: PanGuard): void {
        clearHoldTimer();
        pan.holdX = event.clientX;
        pan.holdY = event.clientY;
        pan.pointerId = event.pointerId;
        pan.guard = guard;
        pan.pending = true;
        pan.holdTimer = window.setTimeout(() => {
            pan.holdTimer = 0;
            if (!pan.pending) {
                return;
            }
            const saved = pan.guard;
            pan.pending = false;
            pan.guard = null;
            discardPanDraft(saved);
            beginPan(pan.holdX, pan.holdY, pan.pointerId);
        }, PAN_HOLD_MS);
    }

    /** Drops the draft created on pointerdown and rewinds any commit it made. */
    function discardPanDraft(guard: PanGuard | null): void {
        popup.close();
        if (drag !== null && drag.mode === "draw") {
            temp = null;
            drag = null;
            paint();
        } else if (drag !== null && drag.mode === "erase") {
            if (eraseBackup !== null) {
                annotations = eraseBackup;
                eraseBackup = null;
            }
            drag = null;
            paint();
        } else if (drag !== null && drag.mode === "crop") {
            drag = null;
            clearCropState();
            shell.setHint(opts.hint ?? null);
            paint();
        }
        if (guard !== null && snapshotJson() !== guard.json) {
            history = history.slice(0, guard.historyIndex + 1);
            historyIndex = guard.historyIndex;
            restore(guard.json, false);
            dirty = guard.dirty;
            stepCounter = guard.stepCounter;
            seedCounter = guard.seedCounter;
            syncChrome();
        }
    }

    function centerCanvas(): void {
        const scroll = refs.scroll;
        scroll.scrollLeft = Math.max(
            0,
            (scroll.scrollWidth - scroll.clientWidth) / 2
        );
        scroll.scrollTop = Math.max(
            0,
            (scroll.scrollHeight - scroll.clientHeight) / 2
        );
    }

    function clampScroll(value: number, range: number): number {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.min(value, Math.max(0, range)));
    }

    /**
     * Zooms to an absolute scale while keeping the image point under the
     * anchor (the viewport centre by default) at the same screen position.
     * Measuring the canvas before and after the relayout also absorbs the
     * scroll-padding change, so a zoom step never shifts the view.
     */
    function zoomTo(next: number, anchorX?: number, anchorY?: number): void {
        const scroll = refs.scroll;
        const target = clampNumber(next, ZOOM_MIN, ZOOM_MAX);
        const before = refs.canvas.getBoundingClientRect();
        const view = scroll.getBoundingClientRect();
        const ax =
            anchorX ?? view.left + scroll.clientLeft + scroll.clientWidth / 2;
        const ay =
            anchorY ?? view.top + scroll.clientTop + scroll.clientHeight / 2;
        const fx = before.width > 0 ? (ax - before.left) / before.width : 0.5;
        const fy = before.height > 0 ? (ay - before.top) / before.height : 0.5;

        zoom = target;
        fitMode = false;
        relayoutAndRender();

        const after = refs.canvas.getBoundingClientRect();
        const contentX = after.left + fx * after.width;
        const contentY = after.top + fy * after.height;
        scroll.scrollLeft = clampScroll(
            scroll.scrollLeft + contentX - ax,
            scroll.scrollWidth - scroll.clientWidth
        );
        scroll.scrollTop = clampScroll(
            scroll.scrollTop + contentY - ay,
            scroll.scrollHeight - scroll.clientHeight
        );
        syncHint();
    }

    let stageExpanded = false;

    function resetStagePadding(): void {
        if (stageExpanded) {
            refs.scroll.style.removeProperty("padding");
            stageExpanded = false;
        }
    }

    /**
     * Outside fit mode the stage always reserves half a viewport of scroll
     * padding on every side. That keeps a scroll range alive even when the
     * image is smaller than the viewport, so zooming out never snaps the view
     * back to the centre and any corner can be dragged to the visible centre.
     */
    function updateStagePadding(): void {
        if (fitMode) {
            resetStagePadding();
            return;
        }
        const scroll = refs.scroll;
        const padX = Math.max(40, Math.round(scroll.clientWidth / 2));
        const padY = Math.max(120, Math.round(scroll.clientHeight / 2));
        scroll.style.padding = `${padY}px ${padX}px`;
        stageExpanded = true;
    }

    function syncHint(): void {
        shell.setHint(
            displayZoom() > 1.0001 ? t("hint.pan") : (opts.hint ?? null)
        );
    }

    let wheelDeltaY = 0;
    let wheelFrame = 0;
    let wheelAnchorX = 0;
    let wheelAnchorY = 0;

    /** Normalises line / page wheel deltas to pixels. */
    function wheelPixelDelta(event: WheelEvent): number {
        if (event.deltaMode === 1) {
            return event.deltaY * 16;
        }
        if (event.deltaMode === 2) {
            return event.deltaY * Math.max(1, refs.scroll.clientHeight);
        }
        return event.deltaY;
    }

    function applyWheelZoom(): void {
        wheelFrame = 0;
        const delta = wheelDeltaY;
        wheelDeltaY = 0;
        if (destroyed || delta === 0) {
            return;
        }
        const steps = clampNumber(-delta / 100, -2, 2);
        if (steps === 0) {
            return;
        }
        const next = clampNumber(
            displayZoom() * Math.pow(1.1, steps),
            ZOOM_MIN,
            ZOOM_MAX
        );
        zoomTo(next, wheelAnchorX, wheelAnchorY);
    }

    function onWheel(event: WheelEvent): void {
        if (destroyed || tool !== "select") {
            return;
        }
        const delta = wheelPixelDelta(event);
        if (delta === 0) {
            return;
        }
        event.preventDefault();
        // A direction change discards the pending delta of the old direction,
        // so the first reverse notch zooms the other way immediately.
        if (wheelDeltaY !== 0 && Math.sign(wheelDeltaY) !== Math.sign(delta)) {
            wheelDeltaY = 0;
        }
        wheelDeltaY += delta;
        wheelAnchorX = event.clientX;
        wheelAnchorY = event.clientY;
        if (wheelFrame === 0) {
            wheelFrame = window.requestAnimationFrame(applyWheelZoom);
        }
    }

    function onPointerDown(event: PointerEvent): void {
        if (destroyed || event.button === 2) {
            return;
        }
        const out = canvasOut(event);
        if (out === null) {
            return;
        }
        if (event.button === 1 || (event.button === 0 && pan.spaceDown)) {
            event.preventDefault();
            try {
                refs.canvas.setPointerCapture(event.pointerId);
            } catch {
                // Pointer capture is best-effort; dragging still works inside the canvas.
            }
            beginPan(event.clientX, event.clientY, event.pointerId);
            return;
        }
        if (textSession !== null) {
            commitTextEditor();
        }
        try {
            refs.canvas.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is best-effort; dragging still works inside the canvas.
        }
        const point = toImage(out);
        const guard: PanGuard = {
            json: history[historyIndex],
            historyIndex,
            stepCounter,
            seedCounter,
            dirty,
        };

        if (tool === "select") {
            const ctx = refs.canvas.getContext("2d") ?? undefined;
            const hit = hitTest(annotations, point[0], point[1], ctx);
            if (hit !== null) {
                selectedId = hit.id;
                drag = {
                    mode: "move",
                    id: hit.id,
                    origin: cloneAnnotation(hit),
                    start: point,
                    startOut: out,
                    moved: false,
                };
                syncChrome();
                paint();
            } else {
                selectedId = null;
                syncChrome();
                paint();
                beginPan(event.clientX, event.clientY, event.pointerId);
            }
            return;
        }

        if (tool === "crop") {
            drag = { mode: "crop", startOut: out, currentOut: out };
            updateCropFromDrag();
            scheduleLongPress(event, guard);
            return;
        }

        if (tool === "text" || tool === "speech") {
            // Keep the focus on the freshly created textarea instead of letting
            // the pointer sequence move it to the canvas/document.
            event.preventDefault();
            openTextEditor(point, out);
            return;
        }

        if (tool === "step") {
            insertStep(point);
            scheduleLongPress(event, guard);
            return;
        }

        if (tool === "emoji") {
            openEmojiPopup(out, point);
            scheduleLongPress(event, guard);
            return;
        }

        if (tool === "cursor") {
            insertCursor(point);
            scheduleLongPress(event, guard);
            return;
        }

        if (tool === "image") {
            void insertImageFromFile(point);
            return;
        }

        if (tool === "eraser") {
            eraseBackup = cloneAnnotations(annotations);
            drag = { mode: "erase" };
            eraseAt(point);
            scheduleLongPress(event, guard);
            return;
        }

        if (isDragTool(tool)) {
            const annotation = createAnnotation(tool, point, point);
            if (tool === "freehand") {
                annotation.points = [point];
            }
            if (tool === "clone") {
                annotation.srcX = point[0];
                annotation.srcY = point[1];
            }
            temp = annotation;
            drag = {
                mode: "draw",
                start: point,
                startOut: out,
                tool,
                moved: false,
            };
            paint();
            scheduleLongPress(event, guard);
        }
    }

    function onPointerMove(event: PointerEvent): void {
        if (destroyed) {
            return;
        }
        if (pan.active) {
            refs.scroll.scrollLeft =
                pan.scrollLeft - (event.clientX - pan.startX);
            refs.scroll.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
            return;
        }
        if (
            pan.pending &&
            Math.hypot(event.clientX - pan.holdX, event.clientY - pan.holdY) >
                PAN_CANCEL
        ) {
            clearHoldTimer();
        }
        if (drag === null) {
            return;
        }
        const out = canvasOut(event);
        if (out === null) {
            return;
        }
        if (drag.mode === "crop") {
            drag.currentOut = out;
            updateCropFromDrag();
            return;
        }
        const point = toImage(out);
        if (drag.mode === "erase") {
            eraseAt(point);
            return;
        }
        const screenDistance = Math.hypot(
            out[0] - drag.startOut[0],
            out[1] - drag.startOut[1]
        );

        if (drag.mode === "move") {
            const move = drag;
            if (screenDistance >= 1) {
                move.moved = true;
            }
            if (!move.moved) {
                return;
            }
            const annotation = annotations.find((item) => item.id === move.id);
            if (!annotation) {
                return;
            }
            const dx = point[0] - move.start[0];
            const dy = point[1] - move.start[1];
            annotation.x1 = move.origin.x1 + dx;
            annotation.y1 = move.origin.y1 + dy;
            annotation.x2 = move.origin.x2 + dx;
            annotation.y2 = move.origin.y2 + dy;
            if (move.origin.points) {
                annotation.points = move.origin.points.map(([x, y]) => [
                    x + dx,
                    y + dy,
                ]);
            }
            paint();
            return;
        }

        if (temp === null) {
            return;
        }
        if (screenDistance >= DRAG_THRESHOLD) {
            drag.moved = true;
        }
        if (drag.tool === "freehand") {
            const points = temp.points ?? [];
            const last = points[points.length - 1];
            if (
                last === undefined ||
                Math.hypot(point[0] - last[0], point[1] - last[1]) >= 1
            ) {
                points.push(point);
            }
            temp.points = points;
            if (points.length > 0) {
                const xs = points.map(([x]) => x);
                const ys = points.map(([, y]) => y);
                temp.x1 = Math.min(...xs);
                temp.x2 = Math.max(...xs);
                temp.y1 = Math.min(...ys);
                temp.y2 = Math.max(...ys);
            }
        } else if (drag.tool === "line" || drag.tool === "arrow") {
            temp.x2 = point[0];
            temp.y2 = point[1];
        } else {
            temp.x1 = drag.start[0];
            temp.y1 = drag.start[1];
            temp.x2 = point[0];
            temp.y2 = point[1];
        }
        paint();
    }

    function onPointerUp(): void {
        if (pan.active) {
            endPan();
            clearHoldTimer();
            return;
        }
        clearHoldTimer();
        if (drag === null) {
            return;
        }
        const finished = drag;
        drag = null;

        if (finished.mode === "crop") {
            finalizeCropSelection();
            return;
        }

        if (finished.mode === "erase") {
            const backup = eraseBackup;
            eraseBackup = null;
            // One drag is one history step; an empty drag stays out of history.
            if (backup !== null && annotations.length !== backup.length) {
                commit();
            } else {
                paint();
            }
            return;
        }

        if (finished.mode === "move") {
            if (finished.moved) {
                commit();
            } else {
                paint();
            }
            return;
        }

        const annotation = temp;
        temp = null;
        if (annotation === null || !finished.moved) {
            paint();
            return;
        }
        if (finished.tool === "clone") {
            void finishClone(annotation);
            return;
        }
        annotations.push(annotation);
        commit();
    }

    function onPointerCancel(): void {
        endPan();
        clearHoldTimer();
        if (drag !== null && drag.mode === "erase" && eraseBackup !== null) {
            annotations = eraseBackup;
            eraseBackup = null;
        }
        drag = null;
        temp = null;
        paint();
    }

    /* ---------------------------------------------------------------- crop */

    function clampCropRect(rect: Rect): Rect {
        const imgW = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        const imgH = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);
        const x = clampNumber(Math.round(rect.x), 0, imgW - 1);
        const y = clampNumber(Math.round(rect.y), 0, imgH - 1);
        const w = clampNumber(Math.round(rect.w), 1, imgW - x);
        const h = clampNumber(Math.round(rect.h), 1, imgH - y);
        return { x, y, w, h };
    }

    function updateCropFromDrag(): void {
        if (drag === null || drag.mode !== "crop" || fit === null) {
            return;
        }
        const { startOut, currentOut } = drag;
        const scale = fit.screenScale;
        cropScreen = {
            x: Math.min(startOut[0], currentOut[0]) * scale,
            y: Math.min(startOut[1], currentOut[1]) * scale,
            w: Math.abs(currentOut[0] - startOut[0]) * scale,
            h: Math.abs(currentOut[1] - startOut[1]) * scale,
        };
        const a = toImage(startOut);
        const b = toImage(currentOut);
        cropRect = {
            x: Math.min(a[0], b[0]),
            y: Math.min(a[1], b[1]),
            w: Math.abs(b[0] - a[0]),
            h: Math.abs(b[1] - a[1]),
        };
        positionCropOverlay();
    }

    function positionCropOverlay(): void {
        if (cropRect === null || cropScreen === null) {
            cropLayer.hidden = true;
            return;
        }
        cropLayer.hidden = false;
        cropBox.style.left = `${cropScreen.x}px`;
        cropBox.style.top = `${cropScreen.y}px`;
        cropBox.style.width = `${Math.max(1, cropScreen.w)}px`;
        cropBox.style.height = `${Math.max(1, cropScreen.h)}px`;
        cropLabel.textContent = `${Math.max(0, Math.round(cropRect.w))} × ${Math.max(
            0,
            Math.round(cropRect.h)
        )}`;
    }

    function clearCropState(): void {
        cropRect = null;
        cropScreen = null;
        cropLayer.hidden = true;
    }

    function finalizeCropSelection(): void {
        if (cropRect === null) {
            clearCropState();
            return;
        }
        if (cropRect.w < CROP_MIN_SIZE || cropRect.h < CROP_MIN_SIZE) {
            clearCropState();
            shell.setHint(opts.hint ?? null);
            return;
        }
        shell.setHint(t("crop.hint"));
        positionCropOverlay();
    }

    async function applyCrop(): Promise<void> {
        if (cropRect === null || destroyed) {
            return;
        }
        const rect = clampCropRect(cropRect);
        if (rect.w < 1 || rect.h < 1) {
            return;
        }
        try {
            const cropped = await cropBaseImage(baseImage, rect);
            if (destroyed) {
                releaseBlobUrl(cropped.src);
                return;
            }
            adoptBaseImage(cropped);
            baseDirty = true;
            dirty = true;
            offsetAnnotations(-rect.x, -rect.y);
            bg = { ...bg, ratio: "Auto" };
            clearCropState();
            selectedId = null;
            tool = "select";
            toolbar.setActiveTool(tool);
            updateCursor();
            shell.setHint(opts.hint ?? null);
            commit();
        } catch {
            toast.show(t("msg.autoCropFailed"), "error");
        }
    }

    /* --------------------------------------------------------- clone tool */

    function imageToDataUrl(
        image: HTMLImageElement,
        width: number,
        height: number
    ): string {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return image.src;
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
    }

    async function finishClone(annotation: Annotation): Promise<void> {
        const bounds = annotationBounds(annotation);
        if (bounds.w < 4 || bounds.h < 4) {
            paint();
            return;
        }
        const rect: Rect = {
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h,
        };
        try {
            // Reuse the crop helper so rounded source coordinates match the
            // annotation's `srcX`/`srcY`.
            const cropped = await cropBaseImage(baseImage, rect);
            if (destroyed) {
                releaseBlobUrl(cropped.src);
                return;
            }
            const src = cropped.src;
            annotation.src = imageToDataUrl(cropped, bounds.w, bounds.h);
            annotation.srcX = Math.round(rect.x);
            annotation.srcY = Math.round(rect.y);
            releaseBlobUrl(src);
            const img = await loadImageElement(annotation.src);
            images.set(annotation.id, img);
            annotations.push(annotation);
            commit();
        } catch {
            paint();
        }
    }

    /* -------------------------------------------------------- text / emoji */

    function measureTextWidth(text: string): number {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return text.length * toolOptions.fontSize * 0.6;
        }
        const weight = toolOptions.bold ? "700" : "400";
        const style = toolOptions.italic ? "italic " : "";
        ctx.font = `${style}${weight} ${toolOptions.fontSize}px "${toolOptions.fontFamily}", "Segoe UI", system-ui, sans-serif`;
        return ctx.measureText(text).width;
    }

    function openTextEditor(point: Point, out: Point): void {
        cancelTextEditor();
        const area = document.createElement("textarea");
        area.className = "am-text-input am-editor-text-input";
        area.rows = 1;
        area.spellcheck = false;
        const scale = fit === null ? 1 : fit.screenScale;
        area.style.left = `${out[0] * scale}px`;
        area.style.top = `${out[1] * scale}px`;
        area.style.fontFamily = toolOptions.fontFamily;
        area.style.fontSize = `${Math.max(8, toolOptions.fontSize * scale)}px`;
        area.style.fontWeight = toolOptions.bold ? "700" : "400";
        area.style.fontStyle = toolOptions.italic ? "italic" : "normal";
        refs.overlay.appendChild(area);

        textSession = {
            element: area,
            point,
            out,
            type: tool === "speech" ? "speech" : "text",
        };

        area.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitTextEditor();
            } else if (event.key === "Escape") {
                event.preventDefault();
                cancelTextEditor();
            }
        });
        area.addEventListener("input", () => {
            area.style.height = "auto";
            area.style.height = `${area.scrollHeight}px`;
        });
        area.addEventListener("blur", () => {
            commitTextEditor();
        });
        area.focus();
    }

    function commitTextEditor(): void {
        const session = textSession;
        if (session === null) {
            return;
        }
        textSession = null;
        const text = session.element.value.trim();
        session.element.remove();
        if (text.length === 0) {
            return;
        }

        if (session.type === "speech") {
            const lines = text.split("\n");
            const lineWidth = Math.max(...lines.map((line) => measureTextWidth(line)));
            const width = Math.max(80, lineWidth + 20);
            const height = lines.length * toolOptions.fontSize * 1.25 + 16;
            const annotation = createAnnotation("speech", session.point, [
                session.point[0] + width,
                session.point[1] + height,
            ]);
            annotation.text = text;
            annotations.push(annotation);
            commit();
            return;
        }

        const annotation = createAnnotation("text", session.point, session.point);
        annotation.text = text;
        annotation.x2 = annotation.x1;
        annotation.y2 = annotation.y1;
        annotations.push(annotation);
        commit();
    }

    function cancelTextEditor(): void {
        const session = textSession;
        if (session === null) {
            return;
        }
        textSession = null;
        session.element.remove();
    }

    function popupAnchorAt(out: Point): HTMLElement {
        const scale = fit === null ? 1 : fit.screenScale;
        const anchor = document.createElement("span");
        anchor.className = "am-anchor";
        anchor.style.position = "absolute";
        anchor.style.left = `${out[0] * scale}px`;
        anchor.style.top = `${out[1] * scale}px`;
        anchor.style.width = "1px";
        anchor.style.height = "1px";
        refs.overlay.appendChild(anchor);
        return anchor;
    }

    function openEmojiPopup(out: Point, point: Point): void {
        const grid = document.createElement("div");
        grid.className = "am-emoji-grid";
        for (const emoji of EMOJI_LIST) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "am-emoji";
            button.textContent = emoji;
            button.addEventListener("click", () => {
                popup.close();
                insertEmoji(emoji, point);
            });
            grid.appendChild(button);
        }
        const anchor = popupAnchorAt(out);
        popup.open(anchor, popupShell(t("msg.emojiTitle"), grid));
        anchor.remove();
    }

    function insertEmoji(emoji: string, point: Point): void {
        const size = EMOJI_BOX;
        const annotation = createAnnotation("emoji", point, [
            point[0] + size,
            point[1] + size,
        ]);
        annotation.emoji = emoji;
        annotation.text = emoji;
        annotations.push(annotation);
        commit();
    }

    function insertStep(point: Point): void {
        const size = Math.max(24, toolOptions.fontSize * STEP_SIZE_RATIO);
        const annotation = createAnnotation("step", point, [
            point[0] + size,
            point[1] + size,
        ]);
        annotation.stepValue = stepCounter;
        annotation.stepType = toolOptions.stepType;
        stepCounter += 1;
        annotations.push(annotation);
        commit();
    }

    function insertCursor(point: Point): void {
        const annotation = createAnnotation("cursor", point, [
            point[0] + CURSOR_SIZE,
            point[1] + CURSOR_SIZE + 6,
        ]);
        annotation.cursorType = toolOptions.cursorType as CursorType;
        annotations.push(annotation);
        commit();
    }

    async function insertImageFromFile(point: Point): Promise<void> {
        const file = await pickImageFile();
        if (file === null || destroyed) {
            return;
        }
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const img = await loadImageElement(dataUrl);
            if (destroyed) {
                return;
            }
            const naturalW = Math.max(1, img.naturalWidth || img.width);
            const naturalH = Math.max(1, img.naturalHeight || img.height);
            const limitW = Math.max(40, (baseImage.naturalWidth || naturalW) * 0.4);
            const limitH = Math.max(40, (baseImage.naturalHeight || naturalH) * 0.4);
            const scale = Math.min(1, limitW / naturalW, limitH / naturalH);
            const width = Math.max(16, naturalW * scale);
            const height = Math.max(16, naturalH * scale);
            const annotation = createAnnotation("image", point, [
                point[0] + width,
                point[1] + height,
            ]);
            annotation.src = dataUrl;
            images.set(annotation.id, img);
            annotations.push(annotation);
            commit();
        } catch {
            toast.show(t("msg.copyFailed"), "error");
        }
    }

    /* -------------------------------------------------------------- resize */

    function openResizePopup(): void {
        const startW = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        const startH = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);

        const form = document.createElement("div");
        form.className = "am-resize-form";

        const widthRow = document.createElement("label");
        widthRow.className = "am-resize-row";
        const widthLabel = document.createElement("span");
        widthLabel.textContent = t("resize.width");
        const widthInput = document.createElement("input");
        widthInput.type = "number";
        widthInput.className = "am-num";
        widthInput.min = "1";
        widthInput.max = "8000";
        widthInput.value = String(startW);
        widthRow.append(widthLabel, widthInput);

        const heightRow = document.createElement("label");
        heightRow.className = "am-resize-row";
        const heightLabel = document.createElement("span");
        heightLabel.textContent = t("resize.height");
        const heightInput = document.createElement("input");
        heightInput.type = "number";
        heightInput.className = "am-num";
        heightInput.min = "1";
        heightInput.max = "8000";
        heightInput.value = String(startH);
        heightRow.append(heightLabel, heightInput);

        const lockRow = document.createElement("label");
        lockRow.className = "am-switch-row";
        const lockLabel = document.createElement("span");
        lockLabel.textContent = t("bg.ratio");
        const lockInput = document.createElement("input");
        lockInput.type = "checkbox";
        lockInput.checked = true;
        const lockSwitch = document.createElement("i");
        lockSwitch.className = "am-switch";
        lockRow.append(lockLabel, lockInput, lockSwitch);

        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "am-ghost-btn am-resize-apply";
        apply.textContent = t("crop.apply");

        const readWidth = (): number =>
            clampNumber(Number.parseFloat(widthInput.value), 1, 8000);
        const readHeight = (): number =>
            clampNumber(Number.parseFloat(heightInput.value), 1, 8000);
        const aspect = startW / startH;

        widthInput.addEventListener("input", () => {
            if (lockInput.checked) {
                heightInput.value = String(
                    Math.max(1, Math.round(readWidth() / aspect))
                );
            }
        });
        heightInput.addEventListener("input", () => {
            if (lockInput.checked) {
                widthInput.value = String(
                    Math.max(1, Math.round(readHeight() * aspect))
                );
            }
        });
        apply.addEventListener("click", () => {
            const width = Math.round(readWidth());
            const height = Math.round(readHeight());
            popup.close();
            void applyResize(width, height);
        });

        form.append(widthRow, heightRow, lockRow, apply);

        if (scene === null) {
            return;
        }
        const anchor = popupAnchorAt([
            scene.img.x + scene.img.w / 2,
            scene.img.y + scene.img.h / 2,
        ]);
        popup.open(anchor, popupShell(t("resize.title"), form));
        anchor.remove();
    }

    function scaleBaseImage(
        width: number,
        height: number
    ): Promise<HTMLImageElement> {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return Promise.reject(new Error("2d context unavailable"));
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
        return loadImageElement(canvas.toDataURL("image/png"));
    }

    async function applyResize(width: number, height: number): Promise<void> {
        const startW = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        const startH = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);
        try {
            const next = await scaleBaseImage(width, height);
            if (destroyed) {
                return;
            }
            adoptBaseImage(next);
            baseDirty = true;
            dirty = true;
            scaleAnnotations(width / startW, height / startH);
            commit();
        } catch {
            toast.show(t("msg.copyFailed"), "error");
        }
    }

    /* ------------------------------------------------------- auto / crop fx */

    async function applyAutoCrop(): Promise<void> {
        const detected = detectAutoCrop(baseImage);
        if (detected === null) {
            toast.show(t("msg.autoCropFailed"), "error");
            return;
        }
        const rect = clampCropRect(detected);
        try {
            const cropped = await cropBaseImage(baseImage, rect);
            if (destroyed) {
                releaseBlobUrl(cropped.src);
                return;
            }
            adoptBaseImage(cropped);
            baseDirty = true;
            dirty = true;
            offsetAnnotations(-rect.x, -rect.y);
            bg = { ...bg, ratio: "Auto" };
            commit();
            toast.show(t("msg.autoCropDone"), "success");
        } catch {
            toast.show(t("msg.autoCropFailed"), "error");
        }
    }

    function imageCenterPoint(): Point {
        if (scene === null) {
            return [
                Math.round((baseImage.naturalWidth || 1) / 2),
                Math.round((baseImage.naturalHeight || 1) / 2),
            ];
        }
        return toImage([scene.img.x + scene.img.w / 2, scene.img.y + scene.img.h / 2]);
    }

    /** Pushes a stack entry and commits (used by no-parameter effects). */
    function pushEffect(id: string): void {
        const entry = createAppliedEffect(id, seedCounter++);
        if (!entry) {
            return;
        }
        effects = { ...effects, stack: [...effects.stack, entry] };
        commit();
    }

    /** Live parameter editor for an existing or pending stack entry. */
    function openParamEditor(
        def: EffectDef,
        effect: AppliedEffect,
        anchor: HTMLElement,
        index: number
    ): void {
        const base = effect;
        openEffectParamPopup({
            t,
            def,
            params: { ...base.params },
            anchor,
            popup,
            onChange(params: ParamDict) {
                if (!draft) {
                    return;
                }
                draft = { ...draft, effect: { ...draft.effect, params: { ...params } } };
                relayout();
            },
            onApply(params: ParamDict) {
                const committed: AppliedEffect = { ...base, params: { ...params } };
                const list = [...effects.stack];
                if (index >= 0) {
                    list[index] = committed;
                } else {
                    list.push(committed);
                }
                draft = null;
                effects = { ...effects, stack: list };
                commit();
            },
            onCancel() {
                draft = null;
                relayoutAndRender();
            },
        });
    }

    /** Opens the background section and flashes the chosen mode's field. */
    function revealBackgroundField(mode: "solid" | "image"): void {
        bg = { ...bg, mode };
        shell.setLeftSection("bg");
        shell.setSidebarOpen("left", true);
        commit();

        for (const timer of fieldFlashTimers) {
            window.clearTimeout(timer);
        }
        fieldFlashTimers = [];
        for (const node of refs.leftBgSection.querySelectorAll<HTMLElement>(
            ".am-field-flash"
        )) {
            node.classList.remove("am-field-flash");
        }
        fieldFlashTimers.push(
            window.setTimeout(() => {
                const target = refs.leftBgSection.querySelector<HTMLElement>(
                    `[data-mode="${mode}"]`
                );
                if (!target) {
                    return;
                }
                target.scrollIntoView({ block: "nearest" });
                target.classList.add("am-field-flash");
                fieldFlashTimers.push(
                    window.setTimeout(() => {
                        target.classList.remove("am-field-flash");
                    }, 1200)
                );
            }, 250)
        );
    }

    /** Tier C: hand the action to the matching editor tool. */
    function runDelegate(def: EffectDef): void {
        switch (def.delegate) {
            case "crop":
                setTool("crop");
                return;
            case "autoCrop":
                void applyAutoCrop();
                return;
            case "resize":
            case "scale":
            case "canvas":
                openResizePopup();
                return;
            case "flip": {
                const horizontal = def.params.find((p) => p.key === "horizontally")?.default === true;
                const vertical = def.params.find((p) => p.key === "vertically")?.default === true;
                const flipH = horizontal || (!horizontal && !vertical);
                effects = {
                    ...effects,
                    flipX: flipH ? (effects.flipX === -1 ? 1 : -1) : effects.flipX,
                    flipY: vertical ? (effects.flipY === -1 ? 1 : -1) : effects.flipY,
                };
                commit();
                return;
            }
            case "flipH":
            case "flipV":
            case "rotate90":
            case "rotate270":
            case "rotate180":
            case "rotateCustom": {
                if (def.delegate === "rotateCustom") {
                    const raw = Number(def.params.find((p) => p.key === "angle")?.default ?? 90);
                    const snapped = Math.round(raw / 90) * 90 || 90;
                    effects = {
                        ...effects,
                        rotate: normalizeRotate(effects.rotate + snapped),
                    };
                } else if (def.delegate === "rotate90") {
                    effects = { ...effects, rotate: normalizeRotate(effects.rotate + 90) };
                } else if (def.delegate === "rotate270") {
                    effects = { ...effects, rotate: normalizeRotate(effects.rotate - 90) };
                } else if (def.delegate === "rotate180") {
                    effects = { ...effects, rotate: normalizeRotate(effects.rotate + 180) };
                } else if (def.delegate === "flipH") {
                    effects = { ...effects, flipX: effects.flipX === -1 ? 1 : -1 };
                } else {
                    effects = { ...effects, flipY: effects.flipY === -1 ? 1 : -1 };
                }
                commit();
                if (def.delegate.startsWith("rotate")) {
                    toast.show(t("msg.rotated"), "success");
                }
                return;
            }
            case "bgSolid":
                revealBackgroundField("solid");
                return;
            case "bgImage":
                revealBackgroundField("image");
                return;
            case "image":
                setTool("image");
                return;
            case "line":
                setTool("line");
                return;
            case "shape":
                setTool("rectangle");
                return;
            case "text":
                setTool("text");
                return;
            case "cursor":
                insertCursor(imageCenterPoint());
                return;
            default:
                return;
        }
    }

    function applyEffect(def: EffectDef, anchor: HTMLElement): void {
        if (destroyed) {
            return;
        }
        if (def.delegate) {
            runDelegate(def);
            return;
        }
        if (hasParams(def)) {
            const entry = createAppliedEffect(def.id, seedCounter++);
            if (!entry) {
                return;
            }
            draft = { index: -1, effect: entry };
            openParamEditor(def, entry, anchor, -1);
            relayoutAndRender();
            return;
        }
        pushEffect(def.id);
    }

    /* ---------------------------------------------------------- files/menus */

    function openFileMenu(anchor: HTMLElement): void {
        if (destroyed) {
            return;
        }
        const menu = document.createElement("div");
        menu.className = "am-menu am-file-menu";

        const addItem = (
            label: string,
            iconId: string | null,
            action: () => void,
            options?: { shortcut?: string; disabled?: boolean }
        ): void => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "am-menu-item";
            button.disabled = options?.disabled === true;
            if (iconId) {
                const icon = document.createElement("span");
                icon.className = "am-menu-icon";
                icon.innerHTML = getIcon(iconId);
                button.appendChild(icon);
            }
            const text = document.createElement("span");
            text.className = "am-menu-label";
            text.textContent = label;
            button.appendChild(text);
            if (options?.shortcut) {
                const kbd = document.createElement("span");
                kbd.className = "am-kbd";
                kbd.textContent = options.shortcut;
                button.appendChild(kbd);
            }
            button.addEventListener("click", () => {
                if (button.disabled) {
                    return;
                }
                popup.close();
                action();
            });
            menu.appendChild(button);
        };

        const addSeparator = (): void => {
            const separator = document.createElement("div");
            separator.className = "am-menu-sep";
            menu.appendChild(separator);
        };

        addItem(t("file.new"), "plus", () => runCommand("new"));
        addItem(t("file.open"), "folder", () => runCommand("open"));

        if (recent.length === 0) {
            addItem(t("file.recentEmpty"), "history", () => undefined, {
                disabled: true,
            });
        } else {
            addItem(t("file.recent"), null, () => undefined, { disabled: true });
            recent.forEach((entry, index) => {
                addItem(entry.name, "image", () => {
                    runCommand("open", String(index));
                });
            });
        }

        addSeparator();
        addItem(t("file.save"), "save", () => runCommand("save"), {
            shortcut: "Ctrl+S",
        });
        addItem(t("file.saveAs"), "save-as", () => runCommand("saveAs"), {
            shortcut: "Ctrl+Shift+S",
        });
        addItem(t("file.copy"), "copy", () => runCommand("copy"), {
            shortcut: "Ctrl+C",
        });
        addItem(t("file.print"), "print", () => runCommand("print"));
        addSeparator();
        addItem(t("file.exit"), "exit", () => runCommand("cancel"));

        popup.open(anchor, menu);
    }

    async function newBlankCanvas(): Promise<void> {
        const width = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        const height = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return;
        }
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, width, height);
        try {
            const img = await loadImageElement(canvas.toDataURL("image/png"));
            if (destroyed) {
                return;
            }
            annotations = [];
            selectedId = null;
            temp = null;
            setBaseImage(img, true);
            commit();
        } catch {
            toast.show(t("msg.copyFailed"), "error");
        }
    }

    async function openLocalImage(): Promise<void> {
        const file = await pickImageFile();
        if (file === null || destroyed) {
            return;
        }
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const img = await loadImageElement(dataUrl);
            if (destroyed) {
                return;
            }
            setBaseImage(img, true);
            pushRecent(file.name || t("file.open"), dataUrl);
        } catch {
            toast.show(t("msg.copyFailed"), "error");
        }
    }

    async function openRecent(index: number): Promise<void> {
        const entry = recent[index];
        if (entry === undefined || destroyed) {
            return;
        }
        try {
            const img = await loadImageElement(entry.src);
            if (destroyed) {
                return;
            }
            setBaseImage(img, true);
            pushRecent(entry.name, entry.src);
        } catch {
            toast.show(t("msg.copyFailed"), "error");
        }
    }

    /* ------------------------------------------------------------- commands */

    function runCommand(command: string, value?: number | string): void {
        if (destroyed) {
            return;
        }
        switch (command) {
            case "cancel":
                opts.onRequestClose(dirty);
                break;
            case "continue":
                opts.onRequestSave("save");
                break;
            case "copy":
            case "copyImage":
                opts.onRequestCopy();
                break;
            case "print":
                opts.onRequestPrint();
                break;
            case "save":
                opts.onRequestSave("save");
                break;
            case "saveAs":
                opts.onRequestSave("saveAs");
                break;
            case "pin":
                toast.show(t("msg.pinUnavailable"), "info");
                break;
            case "upload":
                toast.show(t("msg.uploadUnavailable"), "info");
                break;
            case "fit":
                fitMode = true;
                zoom = 1;
                relayoutAndRender();
                centerCanvas();
                syncHint();
                break;
            case "zoom": {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    break;
                }
                zoomTo(value);
                break;
            }
            case "actualSize":
                fitMode = false;
                zoom = 1;
                relayoutAndRender();
                centerCanvas();
                syncHint();
                break;
            case "undo":
                undo();
                break;
            case "redo":
                redo();
                break;
            case "delete":
                deleteSelected();
                break;
            case "clear":
                clearAnnotations();
                break;
            case "copyAnnotations":
                void copyAnnotationsToClipboard();
                break;
            case "toggleToolbar":
                shell.toggleToolbar();
                break;
            case "new":
                void newBlankCanvas();
                break;
            case "open":
                if (typeof value === "string" && value.length > 0) {
                    void openRecent(Number.parseInt(value, 10));
                } else {
                    void openLocalImage();
                }
                break;
        }
    }

    /* ------------------------------------------------------------ menus */

    function openContextMenuAt(x: number, y: number): void {
        if (destroyed) {
            return;
        }
        const hasSelection = selectedAnnotation() !== null;
        const canUndo = historyIndex > 0;
        const canRedo = historyIndex < history.length - 1;
        const items: ContextMenuItem[] = [
            {
                id: "undo",
                label: t("ctx.undo"),
                shortcut: "Ctrl+Z",
                disabled: !canUndo,
            },
            {
                id: "redo",
                label: t("ctx.redo"),
                shortcut: "Ctrl+Shift+Z",
                disabled: !canRedo,
            },
            { id: "sep1", label: "", separator: true },
            {
                id: "delete",
                label: t("ctx.delete"),
                shortcut: "Del",
                disabled: !hasSelection,
                danger: true,
            },
            {
                id: "clear",
                label: t("ctx.clear"),
                disabled: annotations.length === 0,
                danger: true,
            },
            { id: "sep2", label: "", separator: true },
            {
                id: "copyAnnotations",
                label: t("ctx.copyAnnotations"),
                disabled: !hasSelection && annotations.length === 0,
            },
            { id: "copyImage", label: t("ctx.copyImage"), shortcut: "Ctrl+C" },
            { id: "sep3", label: "", separator: true },
            { id: "toggleToolbar", label: t("ctx.toggleToolbar") },
            { id: "fit", label: t("ctx.fit") },
            { id: "actualSize", label: t("ctx.actualSize") },
        ];
        contextMenu.open(x, y, items, (id) => runCommand(id));
    }

    function onContextMenu(event: MouseEvent): void {
        event.preventDefault();
        popup.close();
        openContextMenuAt(event.clientX, event.clientY);
    }

    /* ------------------------------------------------------------ keyboard */

    function isTypingTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {
            return false;
        }
        const tag = target.tagName;
        return (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            tag === "SELECT" ||
            target.isContentEditable
        );
    }

    function isEditorEvent(event: KeyboardEvent): boolean {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return true;
        }
        if (container.contains(target)) {
            return true;
        }
        // SiYuan focuses `.b3-dialog__container` when the dialog opens, which sits
        // above the editor host; keys pressed there still belong to this editor.
        const dialog = container.closest(".b3-dialog");
        if (dialog !== null && dialog.contains(target)) {
            return true;
        }
        const tag = target.tagName;
        return tag === "BODY" || tag === "HTML";
    }

    /**
     * Unwinds exactly one Escape layer: effects overlay → popup → crop → text
     * input → selection. Returns true when the key was consumed by the editor.
     */
    function escapeStep(): boolean {
        if (shell.isFxOpen()) {
            shell.setFxOpen(false);
            return true;
        }
        if (popup.isOpen()) {
            popup.close();
            return true;
        }
        if (cropRect !== null) {
            clearCropState();
            shell.setHint(opts.hint ?? null);
            paint();
            return true;
        }
        if (textSession !== null) {
            cancelTextEditor();
            return true;
        }
        if (selectedId !== null) {
            selectedId = null;
            syncChrome();
            paint();
            return true;
        }
        return false;
    }

    function onKeyDown(event: KeyboardEvent): void {
        if (destroyed || !isEditorEvent(event) || isTypingTarget(event.target)) {
            return;
        }
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;

        if (event.key === "Escape") {
            // The dialog's capture guard may already have consumed this Escape.
            if (event.defaultPrevented) {
                return;
            }
            escapeStep();
            return;
        }

        if (
            event.code === "Space" &&
            !event.repeat &&
            !modifier &&
            !event.altKey
        ) {
            if (!isTypingTarget(event.target)) {
                event.preventDefault();
                if (!pan.spaceDown) {
                    pan.spaceDown = true;
                    refs.scroll.classList.add("is-pan-ready");
                }
            }
            return;
        }

        if (event.key === "Enter" && cropRect !== null) {
            event.preventDefault();
            void applyCrop();
            return;
        }

        if (modifier) {
            switch (key) {
                case "z":
                    event.preventDefault();
                    if (event.shiftKey) {
                        redo();
                    } else {
                        undo();
                    }
                    return;
                case "y":
                    event.preventDefault();
                    redo();
                    return;
                case "d":
                    event.preventDefault();
                    duplicateSelected();
                    return;
                case "c":
                    event.preventDefault();
                    runCommand("copy");
                    return;
                case "x":
                    event.preventDefault();
                    cutSelected();
                    return;
                case "s":
                    event.preventDefault();
                    runCommand(event.shiftKey ? "saveAs" : "save");
                    return;
                default:
                    return;
            }
        }

        if (event.key === "Delete" || event.key === "Backspace") {
            if (selectedId !== null) {
                event.preventDefault();
                runCommand("delete");
            }
            return;
        }

        if (event.altKey || event.shiftKey) {
            return;
        }

        const nextTool = TOOL_SHORTCUTS[key];
        if (nextTool !== undefined) {
            event.preventDefault();
            setTool(nextTool);
        }
    }

    /* ------------------------------------------------------------ lifecycle */

    function relayoutFromResize(): void {
        if (destroyed) {
            return;
        }
        relayout();
    }

    const resizeObserver =
        typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(() => relayoutFromResize())
            : null;
    resizeObserver?.observe(refs.scroll);

    const onWindowResize = (): void => relayoutFromResize();
    window.addEventListener("resize", onWindowResize);

    const onWindowBlur = (): void => {
        endPan();
        clearHoldTimer();
        pan.spaceDown = false;
        refs.scroll.classList.remove("is-pan-ready");
    };
    window.addEventListener("blur", onWindowBlur);

    function onKeyUp(event: KeyboardEvent): void {
        if (event.code !== "Space") {
            return;
        }
        pan.spaceDown = false;
        if (!pan.active) {
            refs.scroll.classList.remove("is-pan-ready");
        }
    }
    document.addEventListener("keyup", onKeyUp);

    refs.canvas.addEventListener("pointerdown", onPointerDown);
    refs.canvas.addEventListener("pointermove", onPointerMove);
    refs.canvas.addEventListener("pointerup", onPointerUp);
    refs.canvas.addEventListener("pointercancel", onPointerCancel);
    refs.canvas.addEventListener("contextmenu", onContextMenu);
    refs.scroll.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("keydown", onKeyDown);

    /* ---------------------------------------------------------- initial chrome */

    shell.setSidebarTitle("left", t("panel.background"));
    shell.setSidebarTitle("right", t("panel.effects"));
    shell.setLeftSection("bg");
    toolbar.setPanelOpen("templates", false);
    toolbar.setPanelOpen("effects", false);
    toolbar.setActiveTool(tool);
    syncHint();
    backgroundPanel.sync(bg);
    effectsPanel.sync(effects.stack);
    updateCursor();
    ensureAnnotationImages();
    relayoutAndRender();
    // The dialog may still be measuring on the first frame; recompute once the
    // scroll container has its final size.
    window.requestAnimationFrame(() => relayoutFromResize());

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        for (const timer of fieldFlashTimers) {
            window.clearTimeout(timer);
        }
        fieldFlashTimers = [];
        cancelTextEditor();
        clearCropState();
        refs.canvas.removeEventListener("pointerdown", onPointerDown);
        refs.canvas.removeEventListener("pointermove", onPointerMove);
        refs.canvas.removeEventListener("pointerup", onPointerUp);
        refs.canvas.removeEventListener("pointercancel", onPointerCancel);
        refs.canvas.removeEventListener("contextmenu", onContextMenu);
        refs.scroll.removeEventListener("wheel", onWheel);
        if (wheelFrame !== 0) {
            window.cancelAnimationFrame(wheelFrame);
        }
        wheelFrame = 0;
        wheelDeltaY = 0;
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("resize", onWindowResize);
        resizeObserver?.disconnect();
        clearHoldTimer();

        contextMenu.destroy();
        optionsBar.destroy();
        popup.destroy();
        backgroundPanel.destroy();
        templatesPanel.destroy();
        effectsPanel.destroy();
        toolbar.destroy();
        bottomBar.destroy();
        toast.destroy();

        for (const url of objectUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // Ignore already-revoked or invalid URLs.
            }
        }
        objectUrls.length = 0;
        if (baseObjectUrl) {
            try {
                URL.revokeObjectURL(baseObjectUrl);
            } catch {
                // Ignore already-revoked or invalid URLs.
            }
            baseObjectUrl = "";
        }
        images.clear();
        annotations = [];
        history = [];
        historyIndex = -1;
        cropLayer.remove();
        shell.destroy();
    }

    function markSaved(): void {
        dirty = false;
        baseDirty = false;
        syncChrome();
    }

    async function getComposite(): Promise<Blob> {
        const width = Math.max(1, baseImage.naturalWidth || baseImage.width || 1);
        const height = Math.max(1, baseImage.naturalHeight || baseImage.height || 1);
        // Full-resolution render of the effect stack (no preview downscale).
        const heavy = effects.stack.some((item) => isRunnable(item.id));
        if (heavy) {
            toast.show(t("msg.effectsProcessing"), "info");
            // Let the toast paint before the synchronous pixel work blocks the UI.
            await new Promise<void>((resolve) => {
                window.setTimeout(resolve, 16);
            });
        }
        let processed: ProcessedBase;
        try {
            processed = renderEffects(getBaseCanvas(), effects.stack, {
                baseKey: baseKey(),
            });
        } finally {
            if (heavy) {
                toast.hide();
            }
        }
        const scale = processed.scale > 0 ? processed.scale : 1;
        const exportScene = computeScene(
            width,
            height,
            bg,
            normalizeRotate(effects.rotate),
            {
                top: Math.round(processed.pad.top / scale),
                right: Math.round(processed.pad.right / scale),
                bottom: Math.round(processed.pad.bottom / scale),
                left: Math.round(processed.pad.left / scale),
            }
        );

        const jobs: Array<Promise<void>> = [];
        for (const annotation of annotations) {
            if (annotation.type !== "image") {
                continue;
            }
            if (!annotation.src || images.has(annotation.id)) {
                continue;
            }
            const src = annotation.src;
            const id = annotation.id;
            jobs.push(
                loadImageElement(src).then(
                    (img) => {
                        images.set(id, img);
                    },
                    () => undefined
                )
            );
        }
        if (bg.mode === "image" && bg.imageSrc && bgImage === null) {
            const src = bg.imageSrc;
            jobs.push(
                loadImageElement(src).then(
                    (img) => {
                        bgImage = img;
                        bgImageSrc = src;
                    },
                    () => undefined
                )
            );
        }
        if (jobs.length > 0) {
            await Promise.all(jobs);
        }

        return compositeToBlob(exportScene, {
            image: processed.canvas,
            bgImage,
            annotations,
            effects,
            images,
        });
    }

    return {
        destroy,
        isDirty() {
            return dirty;
        },
        getAnnotations() {
            return cloneAnnotations(annotations);
        },
        getSnapshot,
        getComposite,
        markSaved,
        handleCommand(command, value) {
            runCommand(command, value);
        },
        handleEscape() {
            if (destroyed) {
                return false;
            }
            return escapeStep();
        },
        setHint(text) {
            shell.setHint(text);
        },
    };
}

/* ---------------------------------------------------------------- helpers */

function cloneAnnotation(annotation: Annotation): Annotation {
    return JSON.parse(JSON.stringify(annotation)) as Annotation;
}

function cloneAnnotations(list: Annotation[]): Annotation[] {
    return list.map((annotation) => cloneAnnotation(annotation));
}

function normalizeEffects(effects?: EffectState): EffectState {
    const source: Partial<EffectState> = effects ?? {};
    const migrated = migrateEffectState({
        ...(Array.isArray(source.stack) ? { stack: source.stack } : {}),
        ...(Array.isArray(source.filters) ? { filters: source.filters } : {}),
        ...(Array.isArray(source.decorations)
            ? { decorations: source.decorations }
            : {}),
        rotate: Number.isFinite(source.rotate) ? source.rotate : 0,
        flipX: Number.isFinite(source.flipX) ? source.flipX : 1,
        flipY: Number.isFinite(source.flipY) ? source.flipY : 1,
    });
    const stack = (migrated?.stack ?? [])
        .map((item) => sanitizeAppliedEffect(item))
        .filter((item): item is AppliedEffect => item !== null);
    return {
        stack,
        rotate: normalizeRotate(migrated?.rotate ?? 0),
        flipX: (migrated?.flipX ?? 1) === -1 ? -1 : 1,
        flipY: (migrated?.flipY ?? 1) === -1 ? -1 : 1,
    };
}
