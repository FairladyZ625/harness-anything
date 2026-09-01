// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDevRendererUrl,
  createGuiContentSecurityPolicy,
  createGuiWindowOptions,
  guiContentSecurityPolicy,
  isNavigableAppDocumentUrl,
  isTrustedRendererUrl,
} from "../src/index.ts";

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

test("inline script relaxation is dev-only; inline style stays open for xterm's injected stylesheets", () => {
  assert.match(guiContentSecurityPolicy, /script-src 'self';/);
  assert.match(guiContentSecurityPolicy, /style-src 'self' 'unsafe-inline'/);
  const devCsp = createGuiContentSecurityPolicy({ allowDevRenderer: true });
  assert.match(devCsp, /script-src 'self' 'unsafe-inline'/);
  assert.match(devCsp, /style-src 'self' 'unsafe-inline'/);
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

// task_89d324b5:窗口是单文档应用 —— dev 态此前放行同源任意路径,Markdown 里
// `/Users/…` 绝对路径链接解析到 dev origin 之下,点击把窗口带离应用落在 404 白屏。
test("document navigation stays pinned to the app entry document", () => {
  const packagedRendererUrl = "file:///app/renderer/index.html";

  // dev:入口根可停留,同源任意路径(含外链解析出的 /Users/…)一律拒绝。
  assert.equal(
    isNavigableAppDocumentUrl("http://127.0.0.1:5173/", {
      packagedRendererUrl,
      devRendererUrl: "http://127.0.0.1:5173",
    }),
    true,
  );
  assert.equal(
    isNavigableAppDocumentUrl("http://127.0.0.1:5173", {
      packagedRendererUrl,
      devRendererUrl: "http://127.0.0.1:5173/",
    }),
    true,
  );
  assert.equal(
    isNavigableAppDocumentUrl("http://127.0.0.1:5173/Users/ce/Notes/spec.md", {
      packagedRendererUrl,
      devRendererUrl: "http://127.0.0.1:5173",
    }),
    false,
  );
  assert.equal(
    isNavigableAppDocumentUrl("http://localhost:5173/", {
      packagedRendererUrl,
      devRendererUrl: "http://127.0.0.1:5173",
    }),
    false,
  );
  // 打包态:只有入口 index 文档;其余 file:// 与远程 URL 全拒。
  assert.equal(isNavigableAppDocumentUrl(packagedRendererUrl, { packagedRendererUrl }), true);
  assert.equal(isNavigableAppDocumentUrl("file:///Users/ce/Notes/spec.md", { packagedRendererUrl }), false);
  assert.equal(isNavigableAppDocumentUrl("https://example.invalid/", { packagedRendererUrl }), false);
  assert.equal(isNavigableAppDocumentUrl("not a url", { packagedRendererUrl }), false);
});

test("the main window enables only the policy-guarded HTML artifact webview surface", () => {
  const options = createGuiWindowOptions("/app/preload.cjs");
  assert.equal(options.webPreferences.webviewTag, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
});
