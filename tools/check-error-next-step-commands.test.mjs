// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessErrorNextStepCommandBaselineRatchet,
  assessErrorNextStepCommandBaseline,
  inspectErrorNextStepCommands
} from "./check-error-next-step-commands.mjs";

test("rejects a copied command that omits an obviously required option", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution task_1 --verdict changes_requested --findings evidence_missing\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) =>
      finding.rule === "missing-required-option"
      && finding.detail.includes("--rationale")
    ), true);
  });
});

test("rejects an unresolved angle-bracket placeholder in a copied command", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution <task-id> --verdict changes_requested --findings evidence_missing --rationale missing_evidence\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) =>
      finding.rule === "unresolved-placeholder"
      && finding.detail.includes("<task-id>")
    ), true);
  });
});

test("rejects a bare registered command without the ha launcher", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`task review-execution task_1 --verdict changes_requested --findings evidence_missing --rationale missing_evidence\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "bare-command"), true);
  });
});

test("rejects an unknown ha command path", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-dance task_1\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "unknown-command-path"), true);
  });
});

test("rejects an option that is not declared for the matched command", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution task_1 --verdict changes_requested --findings evidence_missing --rationale missing_evidence --magic\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) =>
      finding.rule === "unknown-option"
      && finding.detail.includes("--magic")
    ), true);
  });
});

test("accepts one complete branch of a required option alternative", () => {
  withFixture((rootDir) => {
    write(rootDir, "packages/cli/src/cli/command-spec/task-complete.ts", `
      export const taskCompleteCommandSpec = {
        kind: "task-complete",
        usage: "task complete <id> (--approve --from-file <approval.json> | --commit-anchor <anchor> --judgment <reason>) [--dry-run]",
        options: [
          { flag: "--approve" },
          { flag: "--from-file <approval.json>" },
          { flag: "--commit-anchor <anchor>" },
          { flag: "--judgment <reason>" },
          { flag: "--dry-run" }
        ]
      };
    `);
    write(rootDir, "packages/cli/src/commands/complete.ts", `
      cliError("completion_blocked", "Completion is blocked. Run \`ha task complete task_1 --approve --from-file approval.json\` after addressing the failure.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "missing-required-option"), false);
  });
});

test("accepts a globally declared option on a registered command", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/cli/command-spec/command-groups.ts", `
      export const globalCommandOptions = [{ flag: "--json" }] as const;
    `);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution task_1 --verdict changes_requested --findings evidence_missing --rationale missing_evidence --json\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "unknown-option"), false);
  });
});

test("does not treat natural-language ha words as an unknown command", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Choose one ha command so every lifecycle gate enters admission independently.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "unknown-command-path"), false);
  });
});

test("accepts a command and option declared by special command claims", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/cli/command-spec/special-command-option-claims.ts", `
      export const specialCommandOptionClaims = [
        claim("daemon-status", [["daemon", "status"]], options("--check"))
      ];
    `);
    write(rootDir, "packages/cli/src/commands/daemon.ts", `
      cliError("daemon_failed", "Inspect it with \`ha daemon status --check\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) =>
      finding.rule === "unknown-command-path" || finding.rule === "unknown-option"
    ), false);
  });
});

test("scans registry defaultHint command text", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/cli/error-codes.ts", `
      export const cliErrorCodeRegistry = {
        review_failed: {
          defaultHint: "Review failed. Run \`ha task review-execution <task-id> --verdict changes_requested --findings evidence_missing --rationale missing_evidence\`."
        }
      };
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "unresolved-placeholder"), true);
  });
});

test("does not require execution options when the copied command requests help", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution --help\` and choose the correct inputs.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "missing-required-option"), false);
  });
});

test("does not require option branches when a required group permits a positional operand", () => {
  withFixture((rootDir) => {
    write(rootDir, "packages/cli/src/cli/command-spec/task-archive.ts", `
      export const taskArchiveCommandSpec = {
        kind: "task-archive",
        usage: "task archive (<id> | --ids <id,id> | --filter state:<state>) --reason <reason>",
        options: [
          { flag: "--ids <id,id>" },
          { flag: "--filter state:<state>" },
          { flag: "--reason <reason>" }
        ]
      };
    `);
    write(rootDir, "packages/cli/src/commands/archive.ts", `
      cliError("archive_blocked", "Archive the task with \`ha task archive task_1 --reason obsolete\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "missing-required-option"), false);
  });
});

test("baseline is exact: new and stale findings fail while current debt only warns", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution task_1 --verdict changes_requested --findings evidence_missing\`.");
    `);
    const { findings } = inspectErrorNextStepCommands(rootDir);
    const key = findings[0].key;

    assert.deepEqual(assessErrorNextStepCommandBaseline(findings, [key]).violations, []);
    assert.equal(assessErrorNextStepCommandBaseline(findings, []).violations[0].includes("new finding"), true);
    assert.equal(assessErrorNextStepCommandBaseline([], [key]).violations[0].includes("stale baseline"), true);
  });
});

test("bundled mutation fixtures prove two bad hints red and one good hint green", () => {
  const missing = runFixture("missing-required-option");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing-required-option.*--rationale/u);

  const placeholder = runFixture("unresolved-placeholder");
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /unresolved-placeholder.*<task-id>/u);

  const good = runFixture("good");
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /passed/u);
});

test("resolves a registered route after a value-taking global option", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/cli/command-spec/command-groups.ts", `
      export const globalCommandOptions = [{ flag: "--root DIR" }] as const;
    `);
    write(rootDir, "packages/cli/src/cli/command-spec/special-command-option-claims.ts", `
      export const specialCommandOptionClaims = [
        claim("daemon-connect", [["daemon", "connect"]], options("--stdio"))
      ];
    `);
    write(rootDir, "packages/cli/src/commands/daemon.ts", `
      cliError("daemon_failed", "Reconnect with \`ha --root /tmp/repo daemon connect --stdio\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "unknown-command-path"), false);
  });
});

test("validates each command in a chained copied next step independently", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/cli/command-spec/special-command-option-claims.ts", `
      export const specialCommandOptionClaims = [
        claim("daemon-stop", [["daemon", "stop"]], []),
        claim("daemon-start", [["daemon", "start"]], options("--service"))
      ];
    `);
    write(rootDir, "packages/cli/src/commands/daemon.ts", `
      cliError("daemon_failed", "Restart with \`ha daemon stop && ha daemon start --service\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.deepEqual(result.findings, []);
  });
});

test("rejects a placeholder even when the copied ha route is unknown", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-dance <task-id>\`.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "unresolved-placeholder"), true);
  });
});

test("assigns distinct baseline keys to repeated placeholder occurrences", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run \`ha task review-execution <id> --verdict <id> --findings evidence_missing --rationale missing_evidence\`.");
    `);

    const findings = inspectErrorNextStepCommands(rootDir).findings
      .filter((finding) => finding.rule === "unresolved-placeholder");
    assert.equal(new Set(findings.map((finding) => finding.key)).size, 2);
  });
});

test("baseline ratchet permits only a subset of the previous finding keys", () => {
  assert.deepEqual(
    assessErrorNextStepCommandBaselineRatchet(["finding-a"], ["finding-a", "finding-b"]),
    []
  );
  assert.equal(
    assessErrorNextStepCommandBaselineRatchet(["finding-a", "finding-c"], ["finding-a", "finding-b"])[0]
      .includes("finding-c"),
    true
  );
});

test("baseline identity is stable when unrelated lines move an unchanged hint", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    const errorPath = "packages/cli/src/commands/review.ts";
    const hint = `cliError("review_failed", "Review failed. Run \`ha task review-execution <id> --verdict changes_requested --findings evidence_missing --rationale missing_evidence\`.");`;
    write(rootDir, errorPath, hint);
    const before = inspectErrorNextStepCommands(rootDir).findings[0].key;

    write(rootDir, errorPath, `\n\n${hint}`);
    const after = inspectErrorNextStepCommands(rootDir).findings[0].key;
    assert.equal(after, before);
  });
});

test("repairing one placeholder preserves the baseline identity of another", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    const errorPath = "packages/cli/src/commands/review.ts";
    write(rootDir, errorPath, `
      cliError("review_failed", "Run \`ha task review-execution <task-id> --verdict changes_requested --findings <findings> --rationale evidence_missing\`.");
    `);
    const before = inspectErrorNextStepCommands(rootDir).findings
      .find((finding) => finding.findingIdentity.includes(":<findings>#"))?.key;
    assert.notEqual(before, undefined);

    write(rootDir, errorPath, `
      cliError("review_failed", "Run \`ha task review-execution task_1 --verdict changes_requested --findings <findings> --rationale evidence_missing\`.");
    `);
    const after = inspectErrorNextStepCommands(rootDir).findings
      .find((finding) => finding.findingIdentity.includes(":<findings>#"))?.key;
    assert.notEqual(after, undefined);
    assert.equal(after, before);
  });
});

test("rejects an unquoted bare command introduced as a Run instruction", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/cli/src/commands/review.ts", `
      cliError("review_failed", "Review failed. Run task review-execution task_1 --verdict changes_requested --findings evidence_missing --rationale missing_evidence before retrying.");
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) => finding.rule === "bare-command"), true);
  });
});

test("discovers caller-facing hint sinks in every top-level package src tree", () => {
  withFixture((rootDir) => {
    writeCommandSpec(rootDir);
    write(rootDir, "packages/vscode-ext/src/routing/error.ts", `
      export const failure = {
        hint: "Workspace routing failed. Run \`ha task review-execution <task-id> --verdict changes_requested --findings evidence_missing --rationale missing_evidence\`."
      };
    `);

    const result = inspectErrorNextStepCommands(rootDir);
    assert.equal(result.findings.some((finding) =>
      finding.location.startsWith("packages/vscode-ext/src/")
      && finding.rule === "unresolved-placeholder"
    ), true);
  });
});

function writeCommandSpec(rootDir) {
  write(rootDir, "packages/cli/src/cli/command-spec/task-review-execution.ts", `
    export const taskReviewExecutionCommandSpec = {
      kind: "task-review-execution",
      usage: "task review-execution <id> --verdict <verdict> --findings <text> --rationale <text>",
      options: [
        { flag: "--verdict <verdict>" },
        { flag: "--findings <text>" },
        { flag: "--rationale <text>" }
      ]
    };
  `);
}

function withFixture(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-error-next-step-commands-"));
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function write(rootDir, relativePath, body) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

function runFixture(name) {
  return spawnSync(process.execPath, [
    path.join(process.cwd(), "tools/check-error-next-step-commands.mjs"),
    "--fixture",
    name
  ], { cwd: process.cwd(), encoding: "utf8" });
}
