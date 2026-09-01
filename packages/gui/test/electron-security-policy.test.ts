// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  createStaticWebContentsTrustPolicy,
  evaluateHtmlArtifactAttachment,
  evaluateHtmlArtifactRequest,
  evaluateInAppBrowserAttachment,
  evaluateInAppBrowserUrl,
  evaluateIpcSender,
  evaluateNavigationRequest,
  evaluatePermissionRequest,
  evaluateWindowOpenRequest,
} from "../src/index.ts";

test("IPC sender trust requires both renderer URL and owned webContents id", () => {
  const packagedRendererUrl = "file:///app/renderer/index.html";
  const trustPolicy = {
    ...createStaticWebContentsTrustPolicy([7]),
    rendererUrl: { packagedRendererUrl },
  };

  assert.deepEqual(evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: packagedRendererUrl } }, trustPolicy), {
    action: "allow",
    reason: "trusted_renderer",
  });
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "https://example.invalid" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" },
  );
  assert.deepEqual(evaluateIpcSender({ sender: { id: 9 }, senderFrame: { url: packagedRendererUrl } }, trustPolicy), {
    action: "deny",
    reason: "untrusted_web_contents",
  });
  assert.deepEqual(evaluateIpcSender({ sender: { id: 7 }, senderFrame: null }, trustPolicy), {
    action: "deny",
    reason: "untrusted_renderer_url",
  });
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "http://127.0.0.1:5173" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" },
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "file:///tmp/renderer/index.html" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" },
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "file:///app/.harness-private/task.md" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" },
  );
});

test("HTML artifact guests accept only the isolated data document and no external subresources", () => {
  assert.deepEqual(
    evaluateHtmlArtifactAttachment({
      partition: "html-artifact-preview",
      src: "data:text/html;charset=utf-8,%3Ch1%3Ereport%3C%2Fh1%3E",
    }),
    { action: "allow", reason: "html_artifact_source_allowed" },
  );
  for (const params of [
    { partition: "persist:html-artifact-preview", src: "data:text/html;charset=utf-8,report" },
    { partition: "html-artifact-preview", src: "file:///tmp/report.html" },
    { partition: "html-artifact-preview", src: "https://example.invalid/report.html" },
  ]) {
    assert.equal(evaluateHtmlArtifactAttachment(params).action, "deny");
  }
  assert.equal(evaluateHtmlArtifactRequest("data:image/png;base64,AAAA").action, "allow");
  assert.equal(evaluateHtmlArtifactRequest("about:blank").action, "allow");
  for (const url of [
    "https://example.invalid/a.png",
    "http://127.0.0.1:3000",
    "file:///tmp/private",
    "blob:https://example.invalid/id",
    "not a url",
  ]) {
    assert.equal(evaluateHtmlArtifactRequest(url).action, "deny");
  }
});

test("permission navigation and window-open policies are deny-by-default", () => {
  assert.deepEqual(evaluatePermissionRequest(), {
    action: "deny",
    reason: "permission_denied_by_default",
  });
  assert.deepEqual(evaluateWindowOpenRequest(), {
    action: "deny",
    reason: "window_open_denied",
  });
  assert.deepEqual(evaluateNavigationRequest("https://example.invalid"), {
    action: "deny",
    reason: "navigation_denied",
  });
  assert.deepEqual(
    evaluateNavigationRequest("file:///app/renderer/index.html", {
      packagedRendererUrl: "file:///app/renderer/index.html",
    }),
    {
      action: "allow",
      reason: "trusted_renderer",
    },
  );
  assert.deepEqual(
    evaluateNavigationRequest("file:///tmp/renderer/index.html", {
      packagedRendererUrl: "file:///app/renderer/index.html",
    }),
    {
      action: "deny",
      reason: "navigation_denied",
    },
  );
  assert.deepEqual(
    evaluateNavigationRequest("http://127.0.0.1:5173", { packagedRendererUrl: "file:///app/renderer/index.html" }),
    {
      action: "deny",
      reason: "navigation_denied",
    },
  );
  assert.deepEqual(
    evaluateNavigationRequest("http://127.0.0.1:5173", {
      packagedRendererUrl: "file:///app/renderer/index.html",
      allowDevRenderer: true,
    }),
    {
      action: "allow",
      reason: "trusted_renderer",
    },
  );
});

test("in-app browser accepts only HTTP(S) in its isolated ephemeral partition", () => {
  for (const url of ["http://127.0.0.1:3000", "https://example.invalid/path"]) {
    assert.equal(evaluateInAppBrowserUrl(url).action, "allow");
    assert.equal(evaluateInAppBrowserAttachment({ partition: "in-app-browser", src: url }).action, "allow");
  }
  for (const url of [
    "file:///tmp/private",
    "javascript:alert(1)",
    "chrome://settings",
    "data:text/html,x",
    "not a url",
  ]) {
    assert.equal(evaluateInAppBrowserUrl(url).action, "deny");
    assert.equal(evaluateInAppBrowserAttachment({ partition: "in-app-browser", src: url }).action, "deny");
  }
  assert.equal(
    evaluateInAppBrowserAttachment({ partition: "persist:in-app-browser", src: "https://example.invalid" }).action,
    "deny",
  );
});
