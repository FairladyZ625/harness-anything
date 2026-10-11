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
    settings: { worktree: { setup: ["node-modules", "run: pip install -e ."] } },
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
      "worktree.setup: node-modules; run: pip install -e .",
      "runtime.allowedInstances: not set — every dispatch is rejected " +
        "(run ha init or ha settings update --runtime-allowed-instance <id>)",
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
    settings: { worktree: { setup: [] } },
    lastChanged: "initial",
  });

  assert.deepEqual(rendered, {
    stream: "stdout",
    text: [
      "settings-read: applied",
      "worktree.setup: none",
      "runtime.allowedInstances: not set — every dispatch is rejected " +
        "(run ha init or ha settings update --runtime-allowed-instance <id>)",
      "lastChanged=initial",
    ].join("\n"),
  });
});

test("settings read states the runtime allowlist and what an unset or empty one rejects", () => {
  const set = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    settings: { runtime: { allowedInstances: ["zhipu/glm", "openai/codex"] } },
    lastChanged: "initial",
  });
  assert.match(set.text, /^runtime\.allowedInstances: zhipu\/glm; openai\/codex$/mu);

  const empty = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    settings: { runtime: { allowedInstances: [] } },
    lastChanged: "initial",
  });
  assert.match(
    empty.text,
    /^runtime\.allowedInstances: none — every dispatch is rejected .*--runtime-allowed-instance/mu,
  );
});
