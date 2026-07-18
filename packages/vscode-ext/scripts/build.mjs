import { build } from "esbuild";
import { copyFile, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await Promise.all([
  build({
    entryPoints: ["src/extension/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true
  }),
  build({
    entryPoints: ["src/webviews/main.ts"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    splitting: false,
    target: "es2022",
    sourcemap: true
  }),
  build({
    entryPoints: ["src/test/suite/index.ts"],
    outfile: "dist/test/suite/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"]
  })
]);
await copyFile("../../LICENSE", "dist/LICENSE.txt");
