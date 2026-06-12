import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMarkdownHtml } from "../src/index.ts";

test("Markdown sanitizer strips scripts, handlers, file embeds, remote embeds and private markers", () => {
  const result = sanitizeMarkdownHtml([
    "<h1>Task</h1>",
    "<script>alert(1)</script>",
    "<img src=\"file:///Users/example/secret.png\" onerror=\"steal()\">",
    "<img src=\"https://example.invalid/remote.png\">",
    "<a href=\"javascript:alert(1)\">bad</a>",
    "<iframe src=\"data:text/html,<script>alert(1)</script>\"></iframe>",
    "<img src=\"//example.invalid/protocol-relative.png\">",
    "<img srcset=\"local.png 1x, https://example.invalid/remote-2x.png 2x\">",
    "<a href=\".harness-private/review.md\">private</a>",
    "api_key=abc123",
    "Authorization: Bearer abc123",
    "token=abc123",
    "/tmp/harness-secret.txt",
    "/private/var/tmp/harness-secret.txt"
  ].join("\n"));

  assert.equal(result.html.includes("<script"), false);
  assert.equal(result.html.includes("onerror"), false);
  assert.equal(result.html.includes("file://"), false);
  assert.equal(result.html.includes("https://example.invalid"), false);
  assert.equal(result.html.includes("javascript:"), false);
  assert.equal(result.html.includes("data:text/html"), false);
  assert.equal(result.html.includes("//example.invalid"), false);
  assert.equal(result.html.includes("srcset="), false);
  assert.equal(result.html.includes(".harness-private"), false);
  assert.equal(result.html.includes("api_key"), false);
  assert.equal(result.html.includes("Bearer abc123"), false);
  assert.equal(result.html.includes("token=abc123"), false);
  assert.equal(result.html.includes("/tmp/harness-secret.txt"), false);
  assert.equal(result.html.includes("/private/var/tmp/harness-secret.txt"), false);
  assert.deepEqual(result.strippedReasons, [
    "absolute-local-path",
    "data-embed",
    "event-handler",
    "file-embed",
    "private-harness-path",
    "remote-embed",
    "script-tag",
    "script-url",
    "secret-marker"
  ]);
});
