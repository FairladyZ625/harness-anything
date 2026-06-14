import assert from "node:assert/strict";
import test from "node:test";
import {
  createStaticWebContentsTrustPolicy,
  evaluateBrowserPreviewOpenRequest,
  evaluateIpcSender,
  evaluateNavigationRequest,
  evaluatePermissionRequest,
  evaluateWindowOpenRequest
} from "../src/index.ts";

test("IPC sender trust requires both renderer URL and owned webContents id", () => {
  const packagedRendererUrl = "file:///app/renderer/index.html";
  const trustPolicy = {
    ...createStaticWebContentsTrustPolicy([7]),
    rendererUrl: { packagedRendererUrl }
  };

  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: packagedRendererUrl } }, trustPolicy),
    { action: "allow", reason: "trusted_renderer" }
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "https://example.invalid" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" }
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 9 }, senderFrame: { url: packagedRendererUrl } }, trustPolicy),
    { action: "deny", reason: "untrusted_web_contents" }
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: null }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" }
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "http://127.0.0.1:5173" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" }
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "file:///tmp/renderer/index.html" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" }
  );
  assert.deepEqual(
    evaluateIpcSender({ sender: { id: 7 }, senderFrame: { url: "file:///app/.harness-private/task.md" } }, trustPolicy),
    { action: "deny", reason: "untrusted_renderer_url" }
  );
});

test("permission navigation and window-open policies are deny-by-default", () => {
  assert.deepEqual(evaluatePermissionRequest(), {
    action: "deny",
    reason: "permission_denied_by_default"
  });
  assert.deepEqual(evaluateWindowOpenRequest(), {
    action: "deny",
    reason: "window_open_denied"
  });
  assert.deepEqual(evaluateNavigationRequest("https://example.invalid"), {
    action: "deny",
    reason: "navigation_denied"
  });
  assert.deepEqual(evaluateNavigationRequest("file:///app/renderer/index.html", { packagedRendererUrl: "file:///app/renderer/index.html" }), {
    action: "allow",
    reason: "trusted_renderer"
  });
  assert.deepEqual(evaluateNavigationRequest("file:///tmp/renderer/index.html", { packagedRendererUrl: "file:///app/renderer/index.html" }), {
    action: "deny",
    reason: "navigation_denied"
  });
  assert.deepEqual(evaluateNavigationRequest("http://127.0.0.1:5173", { packagedRendererUrl: "file:///app/renderer/index.html" }), {
    action: "deny",
    reason: "navigation_denied"
  });
  assert.deepEqual(
    evaluateNavigationRequest("http://127.0.0.1:5173", {
      packagedRendererUrl: "file:///app/renderer/index.html",
      allowDevRenderer: true
    }),
    {
      action: "allow",
      reason: "trusted_renderer"
    }
  );
});

test("browser and preview content cannot open without a threat model and remains unshipped", () => {
  assert.deepEqual(
    evaluateBrowserPreviewOpenRequest({
      url: "https://example.invalid",
      source: "open-target-router",
      userGesture: true
    }),
    {
      action: "deny",
      reason: "missing_browser_preview_threat_model",
      detail: "open-target-router"
    }
  );

  assert.deepEqual(
    evaluateBrowserPreviewOpenRequest({
      url: "http://127.0.0.1:3000",
      source: "localhost-preview",
      userGesture: true,
      threatModel: {
        reviewedBy: "M25GUI-P09",
        reviewedAt: "2026-06-14",
        allowedSchemes: ["http:"],
        storagePartition: "ephemeral",
        userGestureRequired: true
      }
    }),
    {
      action: "deny",
      reason: "browser_preview_not_shipped",
      detail: "http://127.0.0.1:3000"
    }
  );
});
