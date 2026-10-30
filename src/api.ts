import { showMessage } from "siyuan";

interface SiYuanResponse {
    code: number;
    msg?: string;
}

interface SiYuanResponseData<T> extends SiYuanResponse {
    data?: T;
}

async function readJson(response: Response): Promise<SiYuanResponse | null> {
    try {
        const data: unknown = await response.json();
        if (typeof data === "object" && data !== null && typeof (data as SiYuanResponse).code === "number") {
            return data as SiYuanResponse;
        }
    } catch {
        // Non-JSON bodies are treated as an invalid API response.
    }
    return null;
}

async function readJsonData<T>(response: Response): Promise<SiYuanResponseData<T> | null> {
    try {
        const body: unknown = await response.json();
        if (typeof body === "object" && body !== null && typeof (body as SiYuanResponse).code === "number") {
            return body as SiYuanResponseData<T>;
        }
    } catch {
        // Non-JSON bodies are treated as an invalid API response.
    }
    return null;
}

/** Reads a workspace file; throws with SiYuan's message when the file cannot be read. */
export async function getFileBlob(path: string): Promise<Blob> {
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ path }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 202 || contentType.includes("application/json")) {
        const data = await readJson(response);
        throw new Error(data?.msg || `Failed to read file: ${path}`);
    }
    if (!response.ok) {
        throw new Error(`Failed to read file: ${path} (${response.status})`);
    }
    return response.blob();
}

/** Writes a file under the workspace data directory; returns true when SiYuan reports success. */
export async function putFile(path: string, data: Blob, fileName: string): Promise<boolean> {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", "false");
    form.append("file", data, fileName);
    const response = await fetch("/api/file/putFile", {
        method: "POST",
        credentials: "same-origin",
        body: form,
    });
    if (!response.ok) {
        return false;
    }
    const result = await readJson(response);
    return result?.code === 0;
}

/** Inserts a markdown block right after `previousBlockId`. */
export async function insertBlock(markdown: string, previousBlockId: string): Promise<boolean> {
    const response = await fetch("/api/block/insertBlock", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            dataType: "markdown",
            data: markdown,
            previousID: previousBlockId,
        }),
    });
    if (!response.ok) {
        return false;
    }
    const data = await readJson(response);
    return data?.code === 0;
}

/** Reads the rendered DOM of a block; null when SiYuan cannot return it. */
export async function getBlockDom(id: string): Promise<string | null> {
    const response = await fetch("/api/block/getBlockDOM", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
    });
    if (!response.ok) {
        return null;
    }
    const result = await readJsonData<{ dom?: unknown }>(response);
    if (result?.code !== 0) {
        return null;
    }
    const dom = result.data?.dom;
    return typeof dom === "string" && dom.length > 0 ? dom : null;
}

/** Replaces a block's DOM; returns true when SiYuan reports success. */
export async function updateBlockDom(id: string, dom: string): Promise<boolean> {
    const response = await fetch("/api/block/updateBlock", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, dataType: "dom", data: dom }),
    });
    if (!response.ok) {
        return false;
    }
    const data = await readJson(response);
    return data?.code === 0;
}

/** Shows a SiYuan message; falls back to the console when showMessage is unavailable. */
export function pushMsg(text: string, type: "info" | "error" | "success" = "info"): void {
    if (typeof showMessage === "function") {
        try {
            showMessage(text, 4000, type);
            return;
        } catch {
            // Fall through to the console when SiYuan's toast is unavailable.
        }
    }
    if (type === "error") {
        console.error(text);
    } else {
        console.log(text);
    }
}
