// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readNodeAutoClaimDiagnostics,
  readNodeAutoClaimPolicy,
  recordNodeAutoClaimDiagnostic,
} from "@harness-anything/daemon/internal/node-auto-claim-config";
import { applyNodeAutoClaimControl, parseNodeAutoClaimControl } from "../src/daemon/node-auto-claim.ts";

test("node auto-claim CLI configures local policy and wakes without exposing credentials", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-"));
  try {
    const parsed = parseNodeAutoClaimControl([
      "enable",
      "--agent",
      "sol",
      "--allow-person",
      "person-a",
      "--allow-team",
      "team-a",
      "--max-concurrent",
      "2",
    ]);
    assert.equal(typeof parsed, "object");
    if (typeof parsed === "string") return;
    let woken = false;
    const enabled = await applyNodeAutoClaimControl(parsed, userRoot, async () => {
      woken = true;
      return true;
    });
    assert.equal(woken, true);
    assert.equal(enabled.activation, "woken");
    assert.deepEqual(readNodeAutoClaimPolicy(userRoot).policy, {
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: ["person-a"], teamIds: ["team-a"] },
      allowedAgentIds: ["sol"],
      maxConcurrent: 2,
    });
    recordNodeAutoClaimDiagnostic(userRoot, {
      repoId: "repo-a",
      taskId: "task-a",
      reason: "source_not_allowed",
      observedAt: "2026-11-02T00:00:00.000Z",
      assignedByPersonId: "person-b",
    });
    const shown = await applyNodeAutoClaimControl({ operation: "status" }, userRoot);
    assert.equal(shown.configuration, "valid");
    assert.equal((shown.recent as { reason: string }[])[0]?.reason, "source_not_allowed");
    assert.equal(JSON.stringify(shown).includes("credential"), false);
    assert.equal(readNodeAutoClaimDiagnostics(userRoot).length, 1);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("node auto-claim CLI rejects an enabled policy with no agent or malformed limits", () => {
  assert.match(String(parseNodeAutoClaimControl(["enable"])), /at least one --agent/u);
  assert.match(String(parseNodeAutoClaimControl(["enable", "--agent", "sol", "--max-concurrent", "0"])), /integer/u);
  assert.match(String(parseNodeAutoClaimControl(["status", "--agent", "sol"])), /does not accept/u);
});
