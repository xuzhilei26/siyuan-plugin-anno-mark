/**
 * Right-click context menu layer.
 *
 * One menu at a time, positioned at the pointer and clamped to the viewport.
 * Outside pointer-down, Escape, another context-menu request and window resize
 * all dismiss it. The menu owns no editor state: it renders descriptors and
 * reports the picked id through `onPick`.
 */
import "./context-menu.css";

export interface ContextMenuItem {
    id: string;
    label: string;
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    separator?: boolean;
}

export interface ContextMenuApi {
    open(
        x: number,
        y: number,
        items: ContextMenuItem[],
        onPick: (id: string) => void
    ): void;
    close(): void;
    destroy(): void;
}

const EDGE = 8;

export function mountContextMenu(layer: HTMLElement): ContextMenuApi {
    let element: HTMLDivElement | null = null;
    let destroyed = false;

    function close(): void {
        if (element === null) {
            return;
        }
        element.remove();
        element = null;
    }

    function open(
        x: number,
        y: number,
        items: ContextMenuItem[],
        onPick: (id: string) => void
    ): void {
        if (destroyed) {
            return;
        }
        close();

        const menu = document.createElement("div");
        menu.className = "am-menu am-context-menu";
        menu.setAttribute("role", "menu");
        // Measure off-screen so the menu never flashes at the viewport origin.
        menu.style.left = "-9999px";
        menu.style.top = "0px";

        for (const item of items) {
            if (item.separator) {
                const separator = document.createElement("div");
                separator.className = "am-menu-sep";
                menu.appendChild(separator);
                continue;
            }

            const button = document.createElement("button");
            button.type = "button";
            button.className = item.danger
                ? "am-menu-item am-menu-item--danger"
                : "am-menu-item";
            button.setAttribute("role", "menuitem");
            button.disabled = item.disabled === true;

            const label = document.createElement("span");
            label.className = "am-menu-label";
            label.textContent = item.label;
            button.appendChild(label);

            if (item.shortcut) {
                const kbd = document.createElement("span");
                kbd.className = "am-kbd";
                kbd.textContent = item.shortcut;
                button.appendChild(kbd);
            }

            button.addEventListener("click", () => {
                if (button.disabled) {
                    return;
                }
                close();
                onPick(item.id);
            });
            menu.appendChild(button);
        }

        layer.appendChild(menu);
        element = menu;

        const rect = menu.getBoundingClientRect();
        const left = Math.max(
            EDGE,
            Math.min(x, window.innerWidth - rect.width - EDGE)
        );
        const top = Math.max(
            EDGE,
            Math.min(y, window.innerHeight - rect.height - EDGE)
        );
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        menu.classList.add("is-open");
    }

    const onPointerDown = (event: PointerEvent): void => {
        if (element === null) {
            return;
        }
        const target = event.target;
        if (target instanceof Node && element.contains(target)) {
            return;
        }
        close();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (element === null || event.key !== "Escape") {
            return;
        }
        close();
        // The menu is the innermost layer: keep Escape away from the editor.
        event.stopPropagation();
    };

    const onContextMenu = (event: MouseEvent): void => {
        if (element === null) {
            return;
        }
        const target = event.target;
        if (target instanceof Node && element.contains(target)) {
            return;
        }
        close();
    };

    const onResize = (): void => close();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("resize", onResize);

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        close();
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        window.removeEventListener("resize", onResize);
    }

    return { open, close, destroy };
}
