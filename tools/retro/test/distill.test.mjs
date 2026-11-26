// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../cli.mjs";
import { clusterFailuresByDefect, runDistill, runDistillCli } from "../distill.mjs";
import { RETRO_DISTILL_PROPOSAL_SCHEMA, collectRetroDistillProposalIssues } from "../lib/schemas.mjs";

function makeTempDir(prefix = "ha-retro-distill-test-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("negative control 1: singleton failure (1 task, even repeated twice) is hard-blocked with 0 proposals", async () => {
  const dir = makeTempDir();
  try {
    const result = await runDistill({
      runId: "singleton-check",
      outDir: dir,
      dryRun: true,
      inputDoc: {
        failures: [
          {
            caseId: "case-solo-1",
            taskId: "task_11111111111111111111111111",
            category: "correctness",
            defectSignature: "missing-null-guard",
            modules: ["packages/application/src/queries"],
            summary: "First occurrence in task 1",
          },
          {
            caseId: "case-solo-2",
            taskId: "task_11111111111111111111111111",
            category: "correctness",
            defectSignature: "missing-null-guard",
            modules: ["packages/application/src/queries"],
            summary: "Second occurrence in the SAME task 1",
          },
        ],
      },
    });

    assert.equal(result.doc.schema, RETRO_DISTILL_PROPOSAL_SCHEMA);
    assert.equal(result.doc.proposals.length, 0, "singleton cluster must generate 0 proposals");
    assert.equal(result.doc.rejectedClusters.length, 1);
    assert.equal(result.doc.rejectedClusters[0].reason, "insufficient_independent_tasks");
    assert.equal(result.doc.rejectedClusters[0].taskCount, 1);
    assert.ok(existsSync(result.proposalJsonPath));
    assert.ok(existsSync(result.prDraftPath));
    assert.equal(collectRetroDistillProposalIssues(result.doc).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control 2: 1/3 probe hit forces deterministic-gate with 0 semantic rule drafts and requires --self-test hitCount > 0", async () => {
  const dir = makeTempDir();
  try {
    const result = await runDistill({
      runId: "probe-boundary-check",
      outDir: dir,
      dryRun: true,
      inputDoc: {
        failures: [
          {
            caseId: "case-a",
            taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            category: "architecture",
            defectSignature: "cross-package-direct-sqlite-import",
            modules: ["packages/application/src", "packages/daemon/src"],
            summary: "Direct sqlite import bypassed storage port",
          },
          {
            caseId: "case-b",
            taskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            category: "architecture",
            defectSignature: "cross-package-direct-sqlite-import",
            modules: ["packages/cli/src"],
            summary: "CLI imported sqlite directly",
          },
        ],
      },
      probeRunner: ({ trial }) => ({
        hit: trial === 1, // 1/3 hits -> must route to deterministic-gate
        evidence: trial === 1 ? "caught once" : "missed cross-file invariant",
      }),
    });

    assert.equal(result.doc.proposals.length, 1);
    const [proposal] = result.doc.proposals;
    assert.equal(proposal.probe.trials, 3);
    assert.equal(proposal.probe.hits, 1);
    assert.equal(proposal.target, "deterministic-gate");
    assert.equal(proposal.ruleDraft, null, "1/3 probe hit must emit 0 semantic .md rule drafts");
    assert.equal(proposal.status, "approved_for_pr");
    assert.ok(proposal.gateSelfTestSpec.command.includes("--self-test"));
    assert.ok(proposal.gateSelfTestSpec.positiveFixtures.length >= 1);
    assert.ok(proposal.gateSelfTestSpec.negativeFixtures.length >= 2);
    assert.ok(proposal.gateSelfTestSpec.hitCount > 0);
    assert.equal(collectRetroDistillProposalIssues(result.doc).length, 0);

    // Zombie gate check: hitCount === 0 must be rejected as rejected_self_test
    const zombieDir = makeTempDir("ha-retro-distill-zombie-");
    try {
      const zombieResult = await runDistill({
        runId: "zombie-gate-check",
        outDir: zombieDir,
        dryRun: true,
        inputDoc: {
          failures: [
            {
              caseId: "case-a",
              taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaa",
              category: "architecture",
              defectSignature: "zombie-gate-defect",
              modules: ["packages/application/src"],
            },
            {
              caseId: "case-b",
              taskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbb",
              category: "architecture",
              defectSignature: "zombie-gate-defect",
              modules: ["packages/application/src"],
            },
          ],
        },
        probeRunner: () => ({ hit: false, evidence: "0/3" }),
        selfTestRunner: () => ({ hitCount: 0, passedCleanFixtures: true }),
      });

      assert.equal(zombieResult.doc.proposals[0].target, "deterministic-gate");
      assert.equal(zombieResult.doc.proposals[0].status, "rejected_self_test");
      assert.equal(zombieResult.doc.summary.approvedProposals, 0);
    } finally {
      rmSync(zombieDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control 3: 3-agent falsification with falsePositiveDelta > 0 blocks approved_for_pr", async () => {
  const dir = makeTempDir();
  try {
    const result = await runDistill({
      runId: "falsification-fp-check",
      outDir: dir,
      dryRun: true,
      inputDoc: {
        failures: [
          {
            caseId: "case-1",
            taskId: "task_11111111111111111111111111",
            category: "review-discipline",
            defectSignature: "missing-evidence-anchor",
            modules: ["tools/retro"],
          },
          {
            caseId: "case-2",
            taskId: "task_22222222222222222222222222",
            category: "review-discipline",
            defectSignature: "missing-evidence-anchor",
            modules: ["tools/retro"],
          },
        ],
      },
      probeRunner: ({ trial }) => ({
        hit: trial <= 2, // 2/3 hits -> semantic-rule
        evidence: trial <= 2 ? "caught" : "missed",
      }),
      falsifierRunner: () => ({
        agents: [
          { role: "proposer", verdict: "pass", rationale: "Catches both incident cases" },
          { role: "adversary", verdict: "reject", rationale: "Triggered 1 false positive on clean control" },
          { role: "arbiter", verdict: "reject", rationale: "Zero-FP gate failed (falsePositiveDelta=1)" },
        ],
        baselineFalsePositives: 0,
        candidateFalsePositives: 1,
        falsePositiveDelta: 1,
        recallDelta: 2,
        verdict: "reject",
      }),
    });

    assert.equal(result.doc.proposals.length, 1);
    const [proposal] = result.doc.proposals;
    assert.equal(proposal.target, "semantic-rule");
    assert.equal(proposal.falsification.falsePositiveDelta, 1);
    assert.equal(proposal.falsification.verdict, "reject");
    assert.equal(proposal.status, "rejected_false_positive");
    assert.equal(result.doc.summary.approvedProposals, 0);
    assert.ok(
      !result.prDraftMarkdown.includes(`### ${proposal.proposalId}`),
      "rejected proposal must not appear in approved section",
    );
    assert.equal(collectRetroDistillProposalIssues(result.doc).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positive path: 2/3 probe hits + 0 FP delta emits L6 four-element semantic-rule proposal and CLI exits 0", async () => {
  const dir = makeTempDir();
  try {
    const inputPath = path.join(dir, "eval-report.json");
    const outDir = path.join(dir, "out");
    writeFileSync(
      inputPath,
      JSON.stringify(
        {
          outcomes: [
            {
              caseId: "case-pos-1",
              taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaa",
              outcome: "fail",
              expectedVerdict: "rework",
              category: "verification",
              defectSignature: "missing-negative-control-test",
              modules: ["tools/retro"],
              summary: "PR omitted negative control test",
            },
            {
              caseId: "case-pos-2",
              taskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbb",
              outcome: "fail",
              expectedVerdict: "rework",
              category: "verification",
              defectSignature: "missing-negative-control-test",
              modules: ["tools/retro"],
              summary: "Second PR omitted negative control test",
            },
            {
              caseId: "case-clean-1",
              taskId: "task_cccccccccccccccccccccccccc",
              outcome: "pass",
              expectedVerdict: "approve",
              bucket: "clean-control",
              category: "verification",
              defectSignature: "missing-negative-control-test",
              modules: ["tools/retro"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const outLines = [];
    const errLines = [];
    const code = await runCli(["distill", "--input", inputPath, "--out-dir", outDir, "--dry-run"], {
      stdout: (line) => outLines.push(line),
      stderr: (line) => errLines.push(line),
    });

    assert.equal(code, 0, errLines.join("\n"));
    const proposalDoc = JSON.parse(readFileSync(path.join(outDir, "proposal.json"), "utf8"));
    assert.equal(proposalDoc.summary.approvedProposals, 1);
    assert.equal(proposalDoc.proposals[0].target, "semantic-rule");
    assert.equal(proposalDoc.proposals[0].status, "approved_for_pr");
    assert.ok(proposalDoc.proposals[0].ruleDraft.ruleText.includes("missing-negative-control-test"));
    assert.equal(collectRetroDistillProposalIssues(proposalDoc).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects --min-tasks < 2 with exit code 2 and schema rejects tampered semantic-rule under 1/3 hits", async () => {
  const errLines = [];
  const code = await runDistillCli(["--input", "dummy.json", "--min-tasks", "1"], {
    stdout: () => {},
    stderr: (line) => errLines.push(line),
  });
  assert.equal(code, 2);
  assert.throws(() => clusterFailuresByDefect([], 1), /minTasks must be an integer >= 2/u);

  const tamperedIssues = collectRetroDistillProposalIssues({
    schema: RETRO_DISTILL_PROPOSAL_SCHEMA,
    version: 1,
    runId: "tampered",
    proposals: [
      {
        proposalId: "prop_bad",
        clusterKey: "arch::x",
        taskIds: ["task_1", "task_2"],
        target: "semantic-rule",
        status: "approved_for_pr",
        scope: { modules: ["packages/application"] },
        invariant: "Must not leak",
        verification: { kind: "semantic-rule-counterexample" },
        probe: { trials: 3, hits: 1, results: [] },
        ruleDraft: { ruleText: "Should not exist" },
        gateSelfTestSpec: null,
        falsification: {
          agents: [{ role: "proposer" }, { role: "adversary" }, { role: "arbiter" }],
          falsePositiveDelta: 1,
          verdict: "reject",
        },
      },
    ],
    rejectedClusters: [],
  });
  assert.ok(tamperedIssues.some((msg) => msg.includes("must route to deterministic-gate")));
  assert.ok(tamperedIssues.some((msg) => msg.includes("cannot be approved_for_pr")));
});
