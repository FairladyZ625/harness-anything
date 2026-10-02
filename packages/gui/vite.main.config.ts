import { builtinModules } from "node:module";
import { isAbsolute } from "node:path";
import { defineConfig } from "vite";

/**
 * Bundles the Electron main process into a single ESM file shipped in the npm
 * package (`ha gui` spawns dist-electron/electron-main.js).
 *
 * Two rules decide what goes in:
 *
 * 1. Workspace packages are bundled. They publish TypeScript sources
 *    (`exports` → `./src/*.ts`), which dev resolves through symlinks landing
 *    outside node_modules. Every materialized install — npm, or the packaged
 *    desktop app — puts those .ts files under node_modules, where Node refuses
 *    to strip types, and the main process dies at import with
 *    ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
 * 2. Everything else stays external and loads as real JS at runtime: Electron,
 *    Node builtins, and third-party packages (native ones such as node-pty
 *    cannot be bundled at all). The desktop runtime ships those under
 *    `resources/app/node_modules` via scripts/prepare-desktop-runtime.mjs.
 */
const WORKSPACE_SCOPE = "@harness-anything/";

export default defineConfig({
  build: {
    lib: {
      entry: "src/main/electron-main.ts",
      formats: ["es"],
      fileName: () => "electron-main.js",
    },
    outDir: "dist-electron",
    // The preload build owns cleaning this directory; run it before this one.
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: {
      external: (id) =>
        id === "electron" ||
        id.startsWith("node:") ||
        builtinModules.includes(id) ||
        (!id.startsWith(".") && !isAbsolute(id) && !id.startsWith(WORKSPACE_SCOPE)),
    },
  },
});
