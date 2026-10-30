import { Plugin, Dialog, confirm } from "siyuan";
import type { Menu } from "siyuan";
import "./index.css";
import { getBlockDom, getFileBlob, insertBlock, pushMsg, putFile, updateBlockDom } from "./api.ts";
import { fileNameOf, isPngPath, normalizeAssetPath } from "./asset-path.ts";
import { mountEditor } from "./editor.ts";
import type { EditorHandle, EditorSnapshot, SaveMode } from "./editor.ts";
import {
    buildProjectMeta,
    encodeMeta,
    originalCachePath,
    readPngText,
    readProjectMetaWithUpgrade,
    sha1Hex,
    writePngText,
} from "./storage.ts";
import { DEFAULT_BG, DEFAULT_EFFECTS, META_KEY } from "./types.ts";
import type { ProjectMetaV2 } from "./types.ts";

declare global {
    interface Window {
        siyuan?: { config?: { lang?: string } };
    }
}

const ICON_SVG = `<symbol id="iconAnnoMark" viewBox="0 0 24 24">
    <rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <rect x="5.6" y="8.4" width="7" height="5.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <path d="M11.6 17.4L19.2 9.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M14.9 9.4l4.3-.6-.6 4.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</symbol>`;

const I18N_BASE = "/plugins/siyuan-plugin-anno-mark/i18n";

interface ImageMenuEvent {
    detail: {
        element: Element;
        menu: Menu;
    };
}

interface EditorSession {
    assetPath: string;
    blockId: string | null;
    bytes: Uint8Array;
    baseImage: HTMLImageElement;
    originalHash: string | null;
}

/** File name without its extension. */
function fileNameStem(assetPath: string): string {
    const name = fileNameOf(assetPath);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/** encodeURI, but keep already percent-encoded sequences untouched. */
function encodeSrcPath(path: string): string {
    return encodeURI(path).replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
}

/** Copies bytes so the Blob part is backed by a plain ArrayBuffer. */
function toBlobPart(bytes: Uint8Array): BlobPart {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

/** Lossless PNG bytes of the image at its natural size. */
function pngBytesFromImage(image: HTMLImageElement): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width || 1;
        canvas.height = image.naturalHeight || image.height || 1;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            reject(new Error("2d context unavailable"));
            return;
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("export failed"));
                return;
            }
            blob.arrayBuffer()
                .then((buffer) => resolve(new Uint8Array(buffer)))
                .catch((error: unknown) => reject(error));
        }, "image/png");
    });
}

export default class AnnoMarkPlugin extends Plugin {
    private dict: Record<string, string> = {};
    private onImageMenu: ((event: ImageMenuEvent) => void) | null = null;

    private dialog: Dialog | null = null;
    private dialogEl: HTMLElement | null = null;
    private dialogCloseGuard: ((event: MouseEvent) => void) | null = null;
    private dialogKeyGuard: ((event: KeyboardEvent) => void) | null = null;
    private editorHandle: EditorHandle | null = null;
    private session: EditorSession | null = null;
    private latestSnapshot: EditorSnapshot | null = null;
    private objectUrls: string[] = [];
    private forceDestroy = false;

    async onload(): Promise<void> {
        this.addIcons(ICON_SVG);
        this.mergeI18n(this.i18n);
        await this.loadI18n();

        const handler = this.handleImageMenu.bind(this);
        this.onImageMenu = handler;
        this.eventBus.on("open-menu-image", handler);
    }

    async onunload(): Promise<void> {
        const handler = this.onImageMenu;
        if (handler) {
            this.eventBus.off("open-menu-image", handler);
            this.onImageMenu = null;
        }
        this.forceDestroy = true;
        this.closeEditor();
        this.teardownEditor();
        this.revokeObjectUrls();
    }

    // ---- i18n ----

    private t = (key: string, vars?: Record<string, string | number>): string => {
        const template = this.dict[key] ?? this.i18nValue(key) ?? key;
        if (!vars) {
            return template;
        }
        return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => {
            const value = vars[name];
            return value === undefined ? `{${name}}` : String(value);
        });
    };

    private i18nValue(key: string): string | undefined {
        const source: unknown = this.i18n;
        if (!source || typeof source !== "object") {
            return undefined;
        }
        const value = (source as Record<string, unknown>)[key];
        return typeof value === "string" ? value : undefined;
    }

    private mergeI18n(source: unknown, prefix = ""): void {
        if (!source || typeof source !== "object") {
            return;
        }
        for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            if (typeof value === "string") {
                this.dict[fullKey] = value;
            } else if (typeof value === "object" && value !== null) {
                this.mergeI18n(value, fullKey);
            }
        }
    }

    /** Fallback dictionary when SiYuan did not inject the static i18n files. */
    private async loadI18n(): Promise<void> {
        const lang = /^zh/i.test(window.siyuan?.config?.lang ?? "") ? "zh_CN" : "en_US";
        try {
            const response = await fetch(`${I18N_BASE}/${lang}.json`, {
                credentials: "same-origin",
            });
            if (!response.ok) {
                return;
            }
            this.mergeI18n(await response.json());
        } catch {
            // SiYuan's bundled i18n already covers the normal case.
        }
    }

    // ---- image menu ----

    private handleImageMenu({ detail }: ImageMenuEvent): void {
        const el = detail.element as HTMLElement;
        const img = el.matches("img") ? (el as HTMLImageElement) : el.querySelector("img");
        if (!img) {
            return;
        }
        const src = img.getAttribute("data-src") || img.getAttribute("src");
        const assetPath = normalizeAssetPath(src);
        if (!assetPath) {
            return;
        }
        const blockId = el.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
        detail.menu.addItem({
            icon: "iconAnnoMark",
            label: this.t("menu.annotateImage"),
            click: () => {
                void this.openEditor(assetPath, blockId);
            },
        });
    }

    // ---- editor dialog ----

    private async openEditor(assetPath: string, blockId: string | null): Promise<void> {
        if (this.dialog) {
            this.forceCloseEditor();
        }
        this.forceDestroy = false;

        const dialog = new Dialog({
            title: `${this.t("title.annotate")} — ${fileNameOf(assetPath)}`,
            width: "92vw",
            height: "88vh",
            content: '<div class="am-dialog-host"></div>',
            destroyCallback: () => this.teardownEditor(),
        });
        this.dialog = dialog;

        const hostEl = dialog.element.querySelector<HTMLElement>(".am-dialog-host");
        if (!hostEl) {
            this.closeEditor();
            return;
        }
        hostEl.style.height = "100%";
        hostEl.style.display = "flex";
        hostEl.style.flexDirection = "column";
        hostEl.style.overflow = "hidden";
        const contentEl = dialog.element.querySelector<HTMLElement>(".b3-dialog__content");
        if (contentEl) {
            contentEl.style.overflow = "hidden";
            contentEl.style.padding = "0";
            contentEl.style.display = "flex";
            contentEl.style.flexDirection = "column";
        }
        // SiYuan caps `.b3-dialog__container` with its own max-width, which would
        // shrink the requested 92vw; the editor needs the full stage width.
        const containerEl = dialog.element.style.width
            ? dialog.element
            : dialog.element.querySelector<HTMLElement>(".b3-dialog__container");
        containerEl?.style.setProperty("max-width", "92vw");
        this.installCloseGuard(dialog.element);

        let blob: Blob;
        let bytes: Uint8Array;
        try {
            blob = await getFileBlob("data/" + assetPath);
            bytes = new Uint8Array(await blob.arrayBuffer());
        } catch {
            if (this.dialog === dialog) {
                pushMsg(this.t("msg.readFailed"), "error");
                this.closeEditor();
            }
            return;
        }
        if (this.dialog !== dialog) {
            return;
        }

        let meta: ProjectMetaV2 | null = null;
        let upgraded = false;
        const hints: string[] = [];
        if (isPngPath(assetPath) && readPngText(bytes, META_KEY) !== null) {
            const decoded = readProjectMetaWithUpgrade(bytes);
            if (decoded) {
                meta = decoded.meta;
                upgraded = decoded.upgraded;
            } else {
                hints.push(this.t("msg.metaCorrupt"));
            }
        }
        if (upgraded) {
            hints.push(this.t("msg.metaUpgraded"));
        }

        let baseBlob = blob;
        let originalHash: string | null = null;
        if (meta?.originalHash) {
            const expectedHash = meta.originalHash;
            let cacheValid = false;
            try {
                const cacheBlob = await getFileBlob(originalCachePath(assetPath, expectedHash));
                const cacheBytes = new Uint8Array(await cacheBlob.arrayBuffer());
                if ((await sha1Hex(cacheBytes)) === expectedHash) {
                    baseBlob = cacheBlob;
                    originalHash = expectedHash;
                    cacheValid = true;
                }
            } catch {
                cacheValid = false;
            }
            if (!cacheValid) {
                // Without the unannotated base, replaying the baked-in effects
                // again would rotate twice and stack duplicate annotations.
                hints.push(this.t("editor.hintMissingOriginal"));
                meta = null;
            }
        }
        if (this.dialog !== dialog) {
            return;
        }

        const objectUrl = URL.createObjectURL(baseBlob);
        this.objectUrls.push(objectUrl);
        const image = new Image();
        image.src = objectUrl;
        try {
            await image.decode();
        } catch {
            if (this.dialog === dialog) {
                pushMsg(this.t("msg.readFailed"), "error");
                this.closeEditor();
            }
            return;
        }
        if (this.dialog !== dialog) {
            // The dialog was destroyed while the image was decoding; the
            // session teardown ran before this URL existed, so release it here.
            try {
                URL.revokeObjectURL(objectUrl);
            } catch {
                // Revoking an already revoked URL is harmless.
            }
            return;
        }

        this.session = { assetPath, blockId, bytes, baseImage: image, originalHash };
        this.editorHandle = mountEditor(hostEl, {
            image,
            annotations: meta?.annotations ?? [],
            bg: meta?.bg ?? DEFAULT_BG,
            effects: meta?.effects ?? DEFAULT_EFFECTS,
            initialTool: meta && meta.annotations.length > 0 ? "select" : "rectangle",
            hint: hints.length > 0 ? hints.join(" · ") : undefined,
            t: this.t,
            onSnapshotChange: (snap) => {
                this.latestSnapshot = snap;
            },
            onRequestSave: (mode) => {
                void this.save(mode);
            },
            onRequestClose: (dirty) => this.requestClose(dirty),
            onRequestCopy: () => {
                void this.copyComposite();
            },
            onRequestPrint: () => {
                void this.printComposite();
            },
        });
    }

    private installCloseGuard(dialogEl: HTMLElement): void {
        const onClick = (event: MouseEvent): void => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }
            if (target.closest(".b3-dialog__close") || target.closest(".b3-dialog__scrim")) {
                this.handleCloseAttempt(event);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") {
                return;
            }
            // The editor unwinds its own layers first (popup → crop → text input
            // → selection); only a fully unwound editor falls through to the
            // unsaved-work confirmation.
            if (this.editorHandle?.handleEscape()) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            this.handleCloseAttempt(event);
        };
        dialogEl.addEventListener("click", onClick, true);
        dialogEl.addEventListener("keydown", onKeyDown, true);
        this.dialogEl = dialogEl;
        this.dialogCloseGuard = onClick;
        this.dialogKeyGuard = onKeyDown;
    }

    private removeCloseGuard(): void {
        const dialogEl = this.dialogEl;
        const onClick = this.dialogCloseGuard;
        const onKeyDown = this.dialogKeyGuard;
        if (dialogEl) {
            if (onClick) {
                dialogEl.removeEventListener("click", onClick, true);
            }
            if (onKeyDown) {
                dialogEl.removeEventListener("keydown", onKeyDown, true);
            }
        }
        this.dialogCloseGuard = null;
        this.dialogKeyGuard = null;
    }

    private handleCloseAttempt(event: Event): void {
        if (this.forceDestroy) {
            return;
        }
        const handle = this.editorHandle;
        if (!handle || !handle.isDirty()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.confirmDiscard();
    }

    /** Asks before dropping unsaved work, then destroys the dialog when confirmed. */
    private confirmDiscard(): void {
        confirm(
            this.t("confirm.discardTitle"),
            this.t("confirm.discardText"),
            () => {
                this.forceDestroy = true;
                this.dialog?.destroy();
            },
            () => {
                // Keep the dialog open and continue editing.
            }
        );
    }

    /** Editor-initiated close (`cancel` / Escape inside the editor). */
    private requestClose(dirty: boolean): void {
        if (this.forceDestroy) {
            return;
        }
        if (!dirty) {
            this.forceDestroy = true;
            this.dialog?.destroy();
            return;
        }
        this.confirmDiscard();
    }

    private forceCloseEditor(): void {
        this.forceDestroy = true;
        this.closeEditor();
    }

    private closeEditor(): void {
        const dialog = this.dialog;
        this.teardownEditor();
        if (dialog) {
            try {
                dialog.destroy();
            } catch {
                // The dialog may already be closing.
            }
        }
    }

    private teardownEditor(): void {
        const handle = this.editorHandle;
        this.editorHandle = null;
        if (handle) {
            try {
                handle.destroy();
            } catch {
                // The editor DOM is already gone when SiYuan closed the dialog.
            }
        }
        this.latestSnapshot = null;
        this.removeCloseGuard();
        this.revokeObjectUrls();
        this.session = null;
        this.dialogEl = null;
        this.dialog = null;
        this.forceDestroy = false;
    }

    private revokeObjectUrls(): void {
        for (const url of this.objectUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // Revoking an already revoked URL is harmless.
            }
        }
        this.objectUrls = [];
    }

    // ---- saving ----

    private async save(mode: SaveMode): Promise<boolean> {
        const handle = this.editorHandle;
        const session = this.session;
        if (!handle || !session) {
            return false;
        }
        const { assetPath, blockId, bytes } = session;
        try {
            const snapshot = handle.getSnapshot();
            const composite = await handle.getComposite();
            const outBytes = new Uint8Array(await composite.arrayBuffer());

            let hash = session.originalHash;
            if (snapshot.baseDirty) {
                // Crop / rotate / resize baked a new base: re-cache it under its hash.
                const baseBytes = await pngBytesFromImage(snapshot.baseImage);
                hash = await sha1Hex(baseBytes);
                const cached = await putFile(
                    originalCachePath(assetPath, hash),
                    new Blob([toBlobPart(baseBytes)], { type: "image/png" }),
                    `${hash}.png`
                );
                if (!cached) {
                    pushMsg(this.t("msg.cacheFailed"), "error");
                }
                session.originalHash = hash;
            } else if (!hash) {
                const baseBytes = isPngPath(assetPath)
                    ? bytes
                    : await pngBytesFromImage(session.baseImage);
                hash = await sha1Hex(baseBytes);
                const cached = await putFile(
                    originalCachePath(assetPath, hash),
                    new Blob([toBlobPart(baseBytes)], { type: "image/png" }),
                    `${hash}.png`
                );
                if (!cached) {
                    pushMsg(this.t("msg.cacheFailed"), "error");
                }
                session.originalHash = hash;
            }

            const meta = buildProjectMeta(
                snapshot.annotations,
                snapshot.effects,
                snapshot.bg,
                fileNameOf(assetPath),
                hash ?? undefined
            );
            const pngBytes = writePngText(outBytes, META_KEY, encodeMeta(meta));
            const pngBlob = new Blob([toBlobPart(pngBytes)], { type: "image/png" });

            if (mode === "save") {
                if (isPngPath(assetPath)) {
                    const saved = await putFile("data/" + assetPath, pngBlob, fileNameOf(assetPath));
                    if (!saved) {
                        pushMsg(this.t("msg.saveFailed"), "error");
                        return false;
                    }
                    this.refreshImages(assetPath);
                    pushMsg(this.t("msg.saveSuccess"), "success");
                    handle.markSaved();
                    this.closeEditor();
                    return true;
                }

                if (!blockId) {
                    // Without a target block the PNG is only written to assets.
                    const newPath = `assets/${fileNameStem(assetPath)}-anno-${Date.now()}.png`;
                    const saved = await putFile("data/" + newPath, pngBlob, fileNameOf(newPath));
                    if (!saved) {
                        pushMsg(this.t("msg.saveFailed"), "error");
                        return false;
                    }
                    handle.markSaved();
                    pushMsg(this.t("msg.savedAsNewNoBlock"), "error");
                    this.closeEditor();
                    return true;
                }

                // Non-PNG assets are converted in place: the source block keeps
                // its position and only its image reference switches to the PNG.
                const newPath = `assets/${fileNameStem(assetPath)}-anno-${blockId}.png`;
                const saved = await putFile("data/" + newPath, pngBlob, fileNameOf(newPath));
                if (!saved) {
                    pushMsg(this.t("msg.saveFailed"), "error");
                    return false;
                }
                const dom = await getBlockDom(blockId);
                if (!dom) {
                    pushMsg(this.t("msg.saveFailed"), "error");
                    return false;
                }
                const encodedAssetPath = encodeURI(assetPath);
                let nextDom = dom.split(assetPath).join(newPath);
                if (encodedAssetPath !== assetPath) {
                    nextDom = nextDom.split(encodedAssetPath).join(newPath);
                }
                if (nextDom === dom) {
                    pushMsg(this.t("msg.saveFailed"), "error");
                    return false;
                }
                const updated = await updateBlockDom(blockId, nextDom);
                if (!updated) {
                    pushMsg(this.t("msg.saveFailed"), "error");
                    return false;
                }
                handle.markSaved();
                pushMsg(this.t("msg.saveSuccess"), "success");
                this.closeEditor();
                return true;
            }

            // saveAs keeps the original behaviour: a new PNG is written and
            // inserted below the source block when its id is known.
            const newPath = `assets/${fileNameStem(assetPath)}-anno-${blockId || Date.now()}.png`;
            const saved = await putFile("data/" + newPath, pngBlob, fileNameOf(newPath));
            if (!saved) {
                pushMsg(this.t("msg.saveFailed"), "error");
                return false;
            }
            if (!blockId) {
                // The annotated PNG is written; the user has to insert it manually.
                handle.markSaved();
                pushMsg(this.t("msg.savedAsNewNoBlock"), "error");
                this.closeEditor();
                return true;
            }
            const inserted = await insertBlock(`![](${newPath})`, blockId);
            if (!inserted) {
                pushMsg(this.t("msg.saveFailed"), "error");
                return false;
            }
            handle.markSaved();
            pushMsg(this.t("msg.savedAsNew"), "success");
            this.closeEditor();
            return true;
        } catch {
            pushMsg(this.t("msg.saveFailed"), "error");
            return false;
        }
    }

    /** Bumps the src of every rendered image that points at the saved asset. */
    private refreshImages(assetPath: string): void {
        const version = Date.now();
        document.querySelectorAll("img").forEach((img) => {
            const dataSrc = img.getAttribute("data-src");
            const currentSrc = img.getAttribute("src");
            if (normalizeAssetPath(dataSrc || currentSrc) !== assetPath) {
                return;
            }
            const bare =
                normalizeAssetPath(currentSrc) === assetPath
                    ? (currentSrc ?? "").split(/[?#]/)[0]
                    : "";
            const base = bare || `/assets/${assetPath.replace(/^assets\//, "")}`;
            img.setAttribute("src", `${encodeSrcPath(base)}?v=${version}`);
        });
    }

    // ---- copy / print ----

    private async copyComposite(): Promise<void> {
        const handle = this.editorHandle;
        if (!handle) {
            pushMsg(this.t("msg.copyFailed"), "error");
            return;
        }
        try {
            const blob = await handle.getComposite();
            if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
                pushMsg(this.t("msg.copyFailed"), "error");
                return;
            }
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            pushMsg(this.t("msg.copied"), "success");
        } catch {
            pushMsg(this.t("msg.copyFailed"), "error");
        }
    }

    private async printComposite(): Promise<void> {
        const handle = this.editorHandle;
        if (!handle) {
            pushMsg(this.t("msg.printBlocked"), "error");
            return;
        }
        let objectUrl: string | null = null;
        const release = (): void => {
            if (objectUrl === null) {
                return;
            }
            const url = objectUrl;
            objectUrl = null;
            try {
                URL.revokeObjectURL(url);
            } catch {
                // Revoking an already revoked URL is harmless.
            }
        };

        try {
            const blob = await handle.getComposite();
            const url = URL.createObjectURL(blob);
            objectUrl = url;

            const win = window.open("", "_blank");
            if (!win) {
                release();
                pushMsg(this.t("msg.printBlocked"), "error");
                return;
            }

            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AnnoMark</title>
<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#fff}
img{max-width:100%;max-height:100vh}</style></head><body><img src="${url}" alt=""></body></html>`;
            win.document.open();
            win.document.write(html);
            win.document.close();

            let printed = false;
            const doPrint = (): void => {
                if (printed) {
                    return;
                }
                printed = true;
                try {
                    win.focus();
                    win.print();
                } catch {
                    // A blocked print dialog leaves the preview window usable.
                }
            };
            const img = win.document.querySelector("img");
            if (img) {
                img.addEventListener("load", doPrint);
                if (img.complete) {
                    doPrint();
                }
            }

            window.setTimeout(release, 60000);
        } catch {
            release();
            pushMsg(this.t("msg.printBlocked"), "error");
        }
    }
}
