// Node 26 ships a built-in `globalThis.localStorage` getter that yields
// `undefined` unless `--localstorage-file` is set. happy-dom skips installing
// its own Storage because the property already exists, so tests that rely on
// `window.localStorage` crash. Install happy-dom's Storage in that one case.
import { Storage } from "happy-dom";
import { stubVirtualizedViewport } from "./virtualizedViewport.ts";

for (const name of ["localStorage", "sessionStorage"] as const) {
  if ((globalThis as Record<string, unknown>)[name] !== undefined) continue;
  Object.defineProperty(globalThis, name, { value: new Storage(), configurable: true, writable: true });
}

// happy-dom has no layout engine: `offsetWidth/offsetHeight` stay 0, and
// @tanstack/virtual reads them synchronously on mount — a 0x0 scroll rect
// renders zero rows. Give DOM-environment files a real viewport (node-env
// files have no HTMLElement global and skip this patch).
if (typeof HTMLElement !== "undefined") stubVirtualizedViewport();
