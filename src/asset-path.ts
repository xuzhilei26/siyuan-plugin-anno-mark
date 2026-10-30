const ASSETS_PREFIX = "assets/";

function stripQueryAndHash(path: string): string {
    const cut = path.search(/[?#]/);
    return cut === -1 ? path : path.slice(0, cut);
}

function decodePath(path: string): string {
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}

/**
 * Normalizes an image element source into a document-relative asset path.
 *
 * Returns `assets/...` (decoded) for images stored inside the workspace asset
 * folder and null for anything else (data/blob URLs, remote hosts, other paths).
 */
export function normalizeAssetPath(src: string | null | undefined): string | null {
    if (!src) {
        return null;
    }
    const raw = src.trim();
    if (!raw || /^(data|blob):/i.test(raw)) {
        return null;
    }

    const relative = raw.startsWith("./") ? raw.slice(2) : raw;
    if (relative.startsWith(ASSETS_PREFIX)) {
        return decodePath(stripQueryAndHash(relative));
    }
    if (raw.startsWith("/" + ASSETS_PREFIX)) {
        return decodePath(stripQueryAndHash(raw.slice(1)));
    }

    let url: URL;
    try {
        url = new URL(raw, location.origin);
    } catch {
        return null;
    }
    if (url.origin !== location.origin) {
        return null;
    }
    const index = url.pathname.indexOf("/" + ASSETS_PREFIX);
    if (index === -1) {
        return null;
    }
    return decodePath(url.pathname.slice(index + 1));
}

/** File name (last path segment, query/hash removed) of a normalized asset path. */
export function fileNameOf(assetPath: string): string {
    const clean = stripQueryAndHash(assetPath);
    const segment = clean.split("/").pop();
    return segment || clean;
}

/** True when the asset path points at a PNG file (case-insensitive). */
export function isPngPath(assetPath: string): boolean {
    return stripQueryAndHash(assetPath).toLowerCase().endsWith(".png");
}
