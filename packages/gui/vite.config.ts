import { builtinModules } from "node:module";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// The renderer module graph is browser-only: a Node builtin reachable from renderer source by a
// value import (`import type` is stripped before resolution and never reaches resolveId) renders
// fine in production builds — rollup can tree-shake the unused stub — but throws during module
// evaluation on the dev server, which unmounts React and leaves a silent white window. Fail the
// transform/build here instead, naming the importing file. Third-party code under node_modules
// is exempt: its own browser-field resolution is out of scope for this guard. Vitest merges this
// config but runs in a Node environment where test files legitimately value-import builtins, so
// the guard does not apply there — its scope is the browser-facing dev/build graphs.
const nodeBuiltinSources = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const rendererNodeBuiltinGuard = (): Plugin => ({
  name: "renderer-node-builtin-guard",
  enforce: "pre",
  apply: () => !process.env.VITEST,
  resolveId(source, importer) {
    if (!nodeBuiltinSources.has(source) || !importer || /[\\/]node_modules[\\/]/u.test(importer)) return null;
    this.error(
      `Renderer module graph must not value-import Node builtin "${source}" ` +
        `(imported by ${importer}): it reaches the browser as an externalized stub ` +
        "that throws at module evaluation and whites out the window.",
    );
  },
});

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [rendererNodeBuiltinGuard(), react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: "index.html",
    },
  },
});
