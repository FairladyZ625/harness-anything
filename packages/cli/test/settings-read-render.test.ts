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
    text: ["settings-read: applied", "worktree.setup: none", "lastChanged=initial"].join("\n"),
  });
});

test("settings read renders every set nested field, including role preferences", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    settings: { roles: { defaultReviewer: "deepseek-reviewer" } },
    lastChanged: "initial",
  });

  assert.match(rendered.text, /^roles\.defaultReviewer: deepseek-reviewer$/mu);
});

test("settings read renders multi-level nested fields as one dotted line each", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    settings: {
      fleet: { claim: { scope: "reserved" } },
      closeout: { profile: "strict", overrides: { review: true, consent: false } },
    },
    lastChanged: "initial",
  });

  assert.match(rendered.text, /^fleet\.claim\.scope: reserved$/mu);
  assert.match(rendered.text, /^closeout\.profile: strict$/mu);
  assert.match(rendered.text, /^closeout\.overrides\.review: true$/mu);
  assert.match(rendered.text, /^closeout\.overrides\.consent: false$/mu);
});

test("settings read prints unset nested fields not at all, in the settings object's key order", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "settings-read",
    outcome: "applied",
    summary: "settings-read: applied",
    settings: {
      schema: "settings/v1",
      defaultVertical: "software/coding",
      roles: { defaultWorker: "zcode-glm" },
      agenda: { pinLimit: 12 },
      worktree: { setup: ["node-modules"] },
    },
    lastChanged: "initial",
  });

  assert.deepEqual(rendered.text.split("\n"), [
    "settings-read: applied",
    "roles.defaultWorker: zcode-glm",
    "agenda.pinLimit: 12",
    "worktree.setup: node-modules",
    "lastChanged=initial",
  ]);
});
