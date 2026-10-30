/**
 * Single-slot toast. Repeated `show` calls replace the text and restart the
 * 2.4s timer instead of stacking messages.
 */
import "./toast.css";
import { getIcon } from "./icons.ts";

export interface ToastApi {
    show(text: string, kind?: "info" | "success" | "error"): void;
    /** Hides immediately without waiting for the 2.4s timer. */
    hide(): void;
    destroy(): void;
}

const TOAST_DURATION = 2400;

export function mountToast(layer: HTMLElement): ToastApi {
    const element = document.createElement("div");
    element.className = "am-toast";

    const icon = document.createElement("span");
    icon.className = "am-toast-icon";
    const text = document.createElement("span");
    text.className = "am-toast-text";
    element.append(icon, text);
    layer.appendChild(element);

    let timer: number | null = null;
    let destroyed = false;

    function clearTimer(): void {
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
    }

    function show(message: string, kind: "info" | "success" | "error" = "info"): void {
        if (destroyed) {
            return;
        }
        element.classList.remove("am-toast--success", "am-toast--error", "is-visible");
        text.textContent = message;
        if (kind === "success") {
            element.classList.add("am-toast--success");
        } else if (kind === "error") {
            element.classList.add("am-toast--error");
        }
        icon.innerHTML = getIcon(kind === "success" ? "check" : kind === "error" ? "close" : "dot");
        // Reflow so the fade-in transition replays for consecutive calls.
        void element.offsetWidth;
        element.classList.add("is-visible");
        clearTimer();
        timer = window.setTimeout(() => {
            element.classList.remove("is-visible");
            timer = null;
        }, TOAST_DURATION);
    }

    function hide(): void {
        clearTimer();
        element.classList.remove("is-visible");
    }

    function destroy(): void {
        if (destroyed) {
            return;
        }
        destroyed = true;
        clearTimer();
        element.remove();
    }

    return { show, hide, destroy };
}
