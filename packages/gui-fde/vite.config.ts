import { builtinModules } from "node:module";
import { realpathSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";

const nodeBuiltinSources = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const rendererNodeBuiltinGuard = (): Plugin => ({
  name: "fde-renderer-node-builtin-guard",
  enforce: "pre",
  resolveId(source, importer) {
    if (!nodeBuiltinSources.has(source) || !importer || /[\\/]node_modules[\\/]/u.test(importer)) return null;
    this.error(`GUI-FDE renderer must not value-import Node builtin "${source}" (imported by ${importer}).`);
  },
});

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [rendererNodeBuiltinGuard(), react(), tailwindcss()],
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(import.meta.dirname),
        ...(["geist", "geist-mono"] as const).map((font) =>
          realpathSync(new URL(`../../node_modules/@fontsource-variable/${font}`, import.meta.url)),
        ),
      ],
    },
  },
  build: {
    assetsInlineLimit: (filePath) => (/\.(?:woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined),
    rollupOptions: {
      input: "index.html",
      onwarn(warning, warn) {
        if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
        warn(warning);
      },
    },
  },
});
