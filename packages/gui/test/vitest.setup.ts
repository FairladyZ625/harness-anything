// Node 26 ships a built-in `globalThis.localStorage` getter that yields
// `undefined` unless `--localstorage-file` is set. happy-dom skips installing
// its own Storage because the property already exists, so tests that rely on
// `window.localStorage` crash. Install happy-dom's Storage in that one case.
import { Storage } from "happy-dom";

for (const name of ["localStorage", "sessionStorage"] as const) {
  if ((globalThis as Record<string, unknown>)[name] !== undefined) continue;
  Object.defineProperty(globalThis, name, { value: new Storage(), configurable: true, writable: true });
}
