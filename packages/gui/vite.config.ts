import { builtinModules } from "node:module";
import { realpathSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";

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
  server: {
    fs: {
      // Worktrees share installed fonts through node_modules symlinks. Permit only
      // those public asset directories outside the normal workspace boundary.
      allow: [
        searchForWorkspaceRoot(import.meta.dirname),
        ...(["geist", "geist-mono"] as const).map((font) =>
          realpathSync(new URL(`../../node_modules/@fontsource-variable/${font}`, import.meta.url)),
        ),
      ],
    },
  },
  build: {
    rollupOptions: {
      input: "index.html",
      // Rollup keeps an import it cannot resolve as an external bare specifier and only warns; the
      // renderer then fails to load it at runtime and the window stays black. Fail the build instead.
      onwarn(warning, warn) {
        if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
        warn(warning);
      },
    },
  },
});
