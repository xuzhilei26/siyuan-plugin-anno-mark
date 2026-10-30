import { cp, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(rootDir, "dist");

const files = ["plugin.json", "icon.png", "preview.png", "README.md"];
const copied = [];

await mkdir(distDir, { recursive: true });

for (const file of files) {
    try {
        await copyFile(join(rootDir, file), join(distDir, file));
        copied.push(file);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[copy-static] skip ${file}: ${reason}`);
    }
}

try {
    await cp(join(rootDir, "i18n"), join(distDir, "i18n"), { recursive: true });
    copied.push("i18n/");
} catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[copy-static] skip i18n/: ${reason}`);
}

console.log(
    `[copy-static] dist ready, copied ${copied.length} item(s): ${
        copied.length > 0 ? copied.join(", ") : "none"
    }`
);
