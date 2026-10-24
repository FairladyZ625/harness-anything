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

// happy-dom ≤20 had no WAAPI, so motion's JS animation backend (driven by
// requestAnimationFrame/performance.now) rendered inline styles tests can
// assert on. happy-dom 21 added `Element.prototype.animate`; motion-dom then
// routes opacity/transform through WAAPI, whose clock this environment never
// advances — animations never settle and every mid-flight cancel rejects the
// native `finished` promise into an unhandled AbortError. Remove the method
// so this lane deterministically tests the JS backend (real-browser WAAPI
// stays covered by the screenshot lane).
if (typeof Element !== "undefined" && Object.hasOwnProperty.call(Element.prototype, "animate")) {
  delete (Element.prototype as { animate?: unknown }).animate;
}
