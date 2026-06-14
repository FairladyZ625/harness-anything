import assert from "node:assert/strict";
import test from "node:test";
import { assertDevRendererUrl, createGuiContentSecurityPolicy, guiContentSecurityPolicy, isTrustedRendererUrl } from "../src/index.ts";

test("dev renderer override accepts only the local Vite server", () => {
  assert.equal(assertDevRendererUrl("http://127.0.0.1:5173"), true);
  assert.throws(() => assertDevRendererUrl("file:///tmp/renderer/index.html"), /local dev renderer/);
  assert.throws(() => assertDevRendererUrl("http://localhost:5173"), /local dev renderer/);
  assert.throws(() => assertDevRendererUrl("https://example.invalid"), /local dev renderer/);
});

test("production CSP does not allow wildcard localhost connections", () => {
  assert.match(guiContentSecurityPolicy, /connect-src 'self'/);
  assert.doesNotMatch(guiContentSecurityPolicy, /127\.0\.0\.1:\*/);
  assert.match(createGuiContentSecurityPolicy({ allowDevRenderer: true }), /http:\/\/127\.0\.0\.1:5173/);
  assert.doesNotMatch(createGuiContentSecurityPolicy({ allowDevRenderer: true }), /127\.0\.0\.1:\*/);
});

test("trusted renderer URL accepts only explicit dev server or packaged renderer file", () => {
  const packagedRendererUrl = "file:///app/renderer/index.html";

  assert.equal(isTrustedRendererUrl(packagedRendererUrl, { packagedRendererUrl }), true);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173", { packagedRendererUrl }), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173", { packagedRendererUrl, allowDevRenderer: true }), true);
  assert.equal(isTrustedRendererUrl("file:///tmp/renderer/index.html", { packagedRendererUrl }), false);
  assert.equal(isTrustedRendererUrl("file:///app/.harness-private/task.md", { packagedRendererUrl }), false);
  assert.equal(isTrustedRendererUrl("https://example.invalid", { packagedRendererUrl }), false);
});
