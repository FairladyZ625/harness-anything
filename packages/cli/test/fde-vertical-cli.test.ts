// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("CLI routes vertical init, preset init, and vertical simulate to their canonical actions", () => {
  const initVertical = parseThinCommand([
    "vertical",
    "init",
    "procurement/review",
    "--title",
    "Procurement Review",
    "--dry-run",
  ]);
  assert.equal(initVertical.ok, true);
  if (initVertical.ok)
    assert.deepEqual(initVertical.command.action, {
      kind: "vertical-init",
      verticalId: "procurement/review",
      title: "Procurement Review",
      dryRun: true,
    });

  const simulate = parseThinCommand(["vertical", "simulate", "--source", "procurement/review", "--locale", "zh-CN"]);
  assert.equal(simulate.ok, true);
  if (simulate.ok)
    assert.deepEqual(simulate.command.action, {
      kind: "vertical-simulate",
      verticalSource: "procurement/review",
      locale: "zh-CN",
    });

  const initPreset = parseThinCommand([
    "preset",
    "init",
    "vendor-check",
    "--vertical",
    "procurement/review",
    "--dry-run",
  ]);
  assert.equal(initPreset.ok, true);
  if (initPreset.ok)
    assert.deepEqual(initPreset.command.action, {
      kind: "preset-init",
      presetId: "vendor-check",
      verticalId: "procurement/review",
      dryRun: true,
    });
});

test("CLI renders broken user preset remediation, scaffold receipts, and vertical simulate summaries", () => {
  const blockedPreset = renderCliReceipt({
    ok: true,
    command: "preset-list",
    evidence: JSON.stringify([
      {
        id: "windows-acceptance",
        title: "windows-acceptance",
        description: 'preset.json contains unknown field "checkerProfile"',
        validity: "blocked",
        nextAction: "Remove the broken user preset pointer with `ha preset uninstall windows-acceptance`.",
      },
    ]),
  });
  assert.equal(blockedPreset.stream, "stdout");
  assert.match(
    blockedPreset.text,
    /remediation: Remove the broken user preset pointer with `ha preset uninstall windows-acceptance`/u,
  );

  const scaffold = renderCliReceipt({
    ok: true,
    command: "vertical-init",
    evidence: JSON.stringify({
      schema: "vertical-scaffold-report/v1",
      mode: "apply",
      targetDir: "verticals/procurement-review",
      verticalId: "procurement/review",
      defaultPresetId: "domain-task",
      workPresetId: "work-root",
      created: ["verticals/procurement-review/vertical.json"],
      overwritten: [],
      nextAction: "Run `ha vertical simulate --source procurement/review`.",
    }),
  });
  assert.equal(scaffold.stream, "stdout");
  assert.match(scaffold.text, /vertical-init \(apply\): verticals\/procurement-review/u);
  assert.match(scaffold.text, /files: created=1 overwritten=0/u);

  const simulate = renderCliReceipt({
    ok: true,
    command: "vertical-simulate",
    evidence: JSON.stringify({
      schema: "vertical-simulate-report/v1",
      ok: true,
      zeroLedgerWrites: true,
      vertical: { id: "procurement/review" },
      bootstrap: { defaultPresetId: "domain-task", defaultProfileId: "verified", workPresetId: "work-root" },
      agents: { ids: ["closeout-reviewer", "contributor"] },
      previews: {
        repository: [{ path: "AGENTS.md" }],
        regularTask: { documents: [{ path: "task_plan.md" }] },
        workTask: { documents: [{ path: "task_plan.md" }] },
      },
      gates: [
        {
          gateId: "deliverable-contract",
          ok: true,
          positive: { result: "pass" },
          negative: { result: "fail" },
        },
      ],
      diagnostics: [],
    }),
  });
  assert.equal(simulate.stream, "stdout");
  assert.match(simulate.text, /vertical-simulate: PASS \(procurement\/review, zeroLedgerWrites=true\)/u);
  assert.match(simulate.text, /gate deliverable-contract: PASS \(positive=pass, negative=fail\)/u);
});
