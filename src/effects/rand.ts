/** Deterministic PRNG helpers shared by noise / particle effects. */

/** Mulberry32: small, fast, stable across runs. */
export function mulberry32(seed: number): () => number {
    let state = (Math.floor(seed) || 1) >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Stable 32-bit hash of a string (FNV-1a), used for stack signatures. */
export function hashString(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** Maps a seed + key to a deterministic integer seed. */
export function deriveSeed(seed: number, key: string): number {
    return (hashString(`${seed}:${key}`) % 0xffffff) + 1;
}
