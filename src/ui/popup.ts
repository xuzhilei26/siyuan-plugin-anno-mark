/**
 * Anchored popup layer. One popup at a time; it is positioned below the anchor
 * (flipped above when the viewport has no room) and clamped horizontally to an
 * 8px viewport margin. Outside pointer-down and Escape close it.
 */
import "./popup.css";

export interface PopupApi {
    open(anchor: HTMLElement, content: HTMLElement, opts?: { className?: string }): void;
    close(): void;
    isOpen(): boolean;
    destroy(): void;
}

const GAP = 6;
const EDGE = 8;

export function mountPopupLayer(layer: HTMLElement): PopupApi {
    let popup: HTMLDivElement | null = null;
    let frame = 0;

    function cancelFrame(): void {
        if (frame !== 0) {
            window.cancelAnimationFrame(frame);
            frame = 0;
        }
    }

    function place(element: HTMLDivElement, anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        const width = element.offsetWidth;
        const height = element.offsetHeight;

        let top = rect.bottom + GAP;
        let above = false;
        if (top + height > window.innerHeight - EDGE) {
            const candidate = rect.top - GAP - height;
            top = candidate >= EDGE ? candidate : Math.max(EDGE, window.innerHeight - EDGE - height);
            above = true;
        }

        let left = rect.left;
        left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - width));

        element.style.left = `${Math.round(left)}px`;
        element.style.top = `${Math.round(top)}px`;
        element.classList.toggle("am-popup--above", above);
    }

    function close(): void {
        if (!popup) {
            return;
        }
        cancelFrame();
        popup.remove();
        popup = null;
    }

    function open(anchor: HTMLElement, content: HTMLElement, opts?: { className?: string }): void {
        close();
        const element = document.createElement("div");
        element.className = opts?.className ? `am-popup ${opts.className}` : "am-popup";
        // Measure off-screen so the popup never flashes at the viewport origin.
        element.style.left = "-9999px";
        element.style.top = "0px";
        element.appendChild(content);
        layer.appendChild(element);
        popup = element;

        place(element, anchor);
        frame = window.requestAnimationFrame(() => {
            frame = 0;
            if (popup === element) {
                element.classList.add("is-open");
            }
        });
    }

    function isOpen(): boolean {
        return popup !== null;
    }

    const onPointerDown = (event: PointerEvent): void => {
        if (!popup) {
            return;
        }
        const target = event.target;
        if (target instanceof Node && popup.contains(target)) {
            return;
        }
        close();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (!popup || event.key !== "Escape") {
            return;
        }
        close();
        // The popup is the innermost layer: do not let Escape reach the dialog.
        event.stopPropagation();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    function destroy(): void {
        close();
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
    }

    return { open, close, isOpen, destroy };
}
