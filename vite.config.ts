import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            fileName: "index",
            formats: ["cjs"],
        },
        outDir: "dist",
        emptyOutDir: true,
        minify: true,
        sourcemap: false,
        cssCodeSplit: false,
        rollupOptions: {
            external: ["siyuan", "process"],
            output: {
                entryFileNames: "index.js",
                assetFileNames: (assetInfo) => {
                    if (assetInfo.name === "style.css") {
                        return "index.css";
                    }
                    return assetInfo.name ?? "[name][extname]";
                },
            },
        },
    },
});
