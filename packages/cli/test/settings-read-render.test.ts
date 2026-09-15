// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("settings read renders the latest settings_changed attribution line", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    lastChanged: {
      occurredAt: "2026-09-10T00:00:00.000Z",
      actor: "agent:runtime-session:worker-1",
      revision: 7,
    },
  });

  assert.deepEqual(rendered, {
    stream: "stdout",
    text: [
      "settings-read: applied",
      "lastChanged=2026-09-10T00:00:00.000Z by=agent:runtime-session:worker-1 revision=7",
    ].join("\n"),
  });
});

test("settings read renders lastChanged=initial before any settings_changed event", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    lastChanged: "initial",
  });

  assert.deepEqual(rendered, {
    stream: "stdout",
    text: ["settings-read: applied", "lastChanged=initial"].join("\n"),
  });
});
