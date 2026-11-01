import { defineConfig } from "tsdown";

/**
 * DSH loads browser plugins as classic scripts. The closure factory keeps the
 * client module in DSH's module table and resolves browser peers through its
 * injected `require`, while the Host broker remains a separate Node entry.
 */
export default defineConfig({
  entry: { client: "src/client.ts" },
  outDir: "dist",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  dts: false,
  clean: false,
  deps: { neverBundle: ["react", "react/jsx-runtime", "react-dom"] },
  outputOptions: {
    entryFileNames: "client.js",
    banner: 'window.__ModuleLoader__.load({ id: "@harness-anything/dsh-plugin", factory: (require) => {',
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
});
