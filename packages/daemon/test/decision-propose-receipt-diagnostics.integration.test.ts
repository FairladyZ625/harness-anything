// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const proposer = {
    actor: { principal: { personId: "person-proposer" }, executor: { kind: "agent", id: "codex" } } as const,
    source: "local" as const,
  },
  basePacket = {
    title: "Diagnostics",
    question: "Should the packet validate?",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "standard-task",
    decisionClass: "ordinary",
    appliesTo: { modules: ["daemon"], productLines: [] },
    chosen: [{ id: "CH1", text: "Use immutable events" }],
    claims: [],
    fulfillments: [],
  };

test("decision propose receipts name the failing packet entry path and its limit", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-diagnostics-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-diagnostics"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-diagnostics-test",
    now: () => "2026-08-15T00:00:00.000Z",
  });
  try {
    const writePacket = (name: string, packet: Record<string, unknown>): string => {
      const target = path.join(rootDir, name);
      writeFileSync(target, JSON.stringify(packet));
      return target;
    };
    const longWhyNot = writePacket("packet-why-not.json", {
      ...basePacket,
      rejected: [{ id: "RJ1", text: "Rewrite files", whyNot: "x".repeat(200) }],
    });
    const whyNotReceipt = await cell.run({ kind: "decision-propose", fromFile: longWhyNot }, proposer);
    assert.equal(whyNotReceipt.outcome, "op_rejected");
    assert.equal(whyNotReceipt.code, "invalid_command");
    assert.match(
      String(whyNotReceipt.rejectionExplanation),
      /rejected\[0\]\.whyNot must be 1\.\.199 code points/u,
      JSON.stringify(whyNotReceipt),
    );
    const extraClaim = writePacket("packet-claims.json", {
      ...basePacket,
      rejected: [{ id: "RJ1", text: "Rewrite files", whyNot: "It loses event history" }],
      claims: [{ id: "C1", text: "The task provides evidence.", loadBearing: true, extra: "nope" }],
    });
    const claimsReceipt = await cell.run({ kind: "decision-propose", fromFile: extraClaim }, proposer);
    assert.equal(claimsReceipt.outcome, "op_rejected");
    assert.equal(claimsReceipt.code, "invalid_command");
    assert.match(
      String(claimsReceipt.rejectionExplanation),
      /claims\[0\] has unsupported fields: extra/u,
      JSON.stringify(claimsReceipt),
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Decision Diagnostics Test");
  git(rootDir, "config", "user.email", "decision-diagnostics@example.invalid");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-qm", "base");
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
