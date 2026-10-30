/**
 * Floating tool toolbar: file menu button, the 21 annotation tools and the two
 * panel entries (saved style templates and the effect overlay).
 */
import "./toolbar.css";
import { iconButton } from "./icons.ts";
import type { TFn, ToolId } from "../types.ts";

export type ToolbarPanel = "templates" | "effects";

export interface ToolbarOptions {
    t: TFn;
    onSelectTool(tool: ToolId): void;
    onPanelToggle(panel: ToolbarPanel): void;
    onFileMenu(anchor: HTMLElement): void;
}

export interface ToolbarApi {
    element: HTMLElement;
    setActiveTool(tool: ToolId): void;
    setPanelOpen(panel: ToolbarPanel, open: boolean): void;
    destroy(): void;
}

interface ToolEntry {
    id: ToolId;
    shortcut: string;
}

/** Toolbar order, matching the prototype's keyboard shortcuts. */
const TOOL_ENTRIES: ToolEntry[] = [
    { id: "select", shortcut: "V" },
    { id: "rectangle", shortcut: "R" },
    { id: "ellipse", shortcut: "E" },
    { id: "line", shortcut: "L" },
    { id: "arrow", shortcut: "A" },
    { id: "freehand", shortcut: "F" },
    { id: "text", shortcut: "T" },
    { id: "speech", shortcut: "O" },
    { id: "step", shortcut: "N" },
    { id: "image", shortcut: "I" },
    { id: "clone", shortcut: "D" },
    { id: "emoji", shortcut: "J" },
    { id: "cursor", shortcut: "K" },
    { id: "highlight", shortcut: "H" },
    { id: "eraser", shortcut: "W" },
    { id: "blur", shortcut: "B" },
    { id: "pixelate", shortcut: "P" },
    { id: "magnify", shortcut: "M" },
    { id: "spotlight", shortcut: "S" },
    { id: "crop", shortcut: "C" },
    { id: "cutout", shortcut: "U" },
];

function makeDivider(): HTMLSpanElement {
    const divider = document.createElement("span");
    divider.className = "am-divider";
    return divider;
}

export function mountToolbar(
    container: HTMLElement,
    options: ToolbarOptions
): ToolbarApi {
    const { t } = options;
    const element = document.createElement("div");
    element.className = "am-toolbar";

    const toolButtons = new Map<ToolId, HTMLButtonElement>();
    const panelButtons: Record<ToolbarPanel, HTMLButtonElement> = {
        templates: iconButton("bookmark", t("panel.templates"), "am-panel-btn"),
        effects: iconButton("wand", t("effects.title"), "am-panel-btn"),
    };

    function addTool(entry: ToolEntry): void {
        const label = `${t(`tool.${entry.id}`)} (${entry.shortcut})`;
        const btn = iconButton(entry.id, label);
        btn.dataset.tool = entry.id;
        btn.classList.add("am-tool-btn");
        btn.addEventListener("click", () => options.onSelectTool(entry.id));
        toolButtons.set(entry.id, btn);
        element.appendChild(btn);
    }

    // File menu button.
    const fileBtn = iconButton("file", t("menu.file"), "am-file-btn");
    fileBtn.dataset.action = "file-menu";
    fileBtn.addEventListener("click", () => options.onFileMenu(fileBtn));
    element.append(fileBtn, makeDivider());

    // Drawing tools (19) before the crop group.
    for (const entry of TOOL_ENTRIES.slice(0, 19)) {
        addTool(entry);
    }
    element.appendChild(makeDivider());
    for (const entry of TOOL_ENTRIES.slice(19)) {
        addTool(entry);
    }
    element.appendChild(makeDivider());

    // Panel entries: saved style templates (left sidebar) and effects (overlay).
    const panelGroup = document.createElement("div");
    panelGroup.className = "am-group";
    for (const panel of ["templates", "effects"] as const) {
        const btn = panelButtons[panel];
        btn.dataset.panel = panel;
        btn.addEventListener("click", () => options.onPanelToggle(panel));
        panelGroup.appendChild(btn);
    }
    element.appendChild(panelGroup);

    container.appendChild(element);

    let destroyed = false;

    function setActiveTool(tool: ToolId): void {
        if (destroyed) {
            return;
        }
        toolButtons.forEach((btn, id) => {
            btn.classList.toggle("is-active", id === tool);
        });
    }

    function setPanelOpen(panel: ToolbarPanel, open: boolean): void {
        if (destroyed) {
            return;
        }
        panelButtons[panel].classList.toggle("is-active", open);
    }

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        element.remove();
    }

    return { element, setActiveTool, setPanelOpen, destroy };
}
