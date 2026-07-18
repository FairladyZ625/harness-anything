/**
 * P3 wall-clock fixture: hermetic ledger for Overview + Execution Evidence load.
 * Authored root is git-seeded; people.yaml grants unix-socket-owner-boundary auth.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export function writePerfFixture(rootDir, size, outputsPerExecution) {
  const t0 = performance.now();
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    [
      "schema: harness-anything/v1",
      `name: p3-wall-clock-${size}x${outputsPerExecution}`,
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "",
    ].join("\n"),
  );
  // people.yaml is required for daemon unix-socket-owner-boundary auth on today's main.
  // Without it the ledger bridge fails and Overview reports taskCount=0 forever.
  writeFileSync(
    path.join(rootDir, "harness", "people.yaml"),
    [
      "schema: harness-people/v1",
      "people:",
      "  - personId: person_perf",
      "    displayName: P3 Perf",
      "    primaryEmail: p3-perf@example.test",
      "    roles: [owner]",
      "    credentials:",
      "      - kind: unix-socket-owner-boundary",
      `        issuer: host:${hostname()}`,
      `        subject: ${process.getuid?.() ?? 0}`,
      "roles:",
      "  - roleId: owner",
      "    commandClasses: [admin, repo-write, repo-read, arbiter]",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(rootDir, "harness", "tasks"), { recursive: true });
  mkdirSync(path.join(rootDir, "harness", "decisions", "decision-dec_p3_perf"), { recursive: true });

  // One decision so Overview has non-empty proposed queue structure.
  writeFileSync(
    path.join(rootDir, "harness", "decisions", "decision-dec_p3_perf", "decision.md"),
    [
      "---",
      "schema: decision-package/v1",
      "decision_id: dec_p3_perf",
      "_coordinatorWatermark: p3-perf",
      'title: "P3 performance decision"',
      "state: proposed",
      "riskTier: medium",
      "urgency: medium",
      'vertical: "software/coding"',
      'preset: "architecture-decision"',
      "applies_to:",
      '  modules: ["gui"]',
      "  productLines: []",
      'proposedAt: "2026-07-13T00:00:00.000Z"',
      "provenance:",
      '  - {runtime: "codex", sessionId: "p3-perf", boundAt: "2026-07-13T00:00:00.000Z"}',
      'question: "Is the first screen bounded?"',
      "chosen:",
      '  - {id: "CH1", text: "Bound first screen"}',
      "rejected: []",
      "claims:",
      '  - {id: "CH1", text: "Windowed rows keep DOM under ceiling", load_bearing: true}',
      "relations: []",
      "---",
      "",
    ].join("\n"),
  );

  for (let index = 0; index < size; index += 1) {
    const taskId = `task_${String(index).padStart(26, "0")}`;
    const executionId = `exe_${String(index).padStart(26, "0")}`;
    const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      [
        "---",
        "schema: task-package/v2",
        `task_id: ${taskId}`,
        `title: Performance Task ${index}`,
        "lifecycle:",
        "  bindingSchema: lifecycle-binding/v1",
        "  engine: local",
        "  status: in_review",
        "  ref: ",
        `  titleSnapshot: Performance Task ${index}`,
        "  url: ",
        "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
        `  bindingFingerprint: sha256:${"0".repeat(64)}`,
        "packageDisposition: active",
        "vertical: software/coding",
        "preset: standard-task",
        "---",
        "",
        `# Performance Task ${index}`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(taskRoot, "facts.md"),
      [
        "# Facts",
        "",
        `- {fact_id: F-${String(index).padStart(8, "0")}, statement: "Projected performance fact ${index}", source: "benchmark", observedAt: "2026-07-13T00:00:00.000Z", confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: "codex", sessionId: "benchmark", boundAt: "2026-07-13T00:00:00.000Z"}]}`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(taskRoot, "executions", `${executionId}.md`),
      `${JSON.stringify(
        {
          schema: "execution/v2",
          execution_id: executionId,
          task_ref: `task/${taskId}`,
          state: "submitted",
          primary_actor: {
            principal: { personId: "person_perf" },
            executor: { kind: "agent", id: "codex" },
            responsibleHuman: "person_perf",
          },
          claimed_at: "2026-07-13T00:00:00.000Z",
          submitted_at: "2026-07-13T00:01:00.000Z",
          closed_at: null,
          session_bindings: [],
          outputs: Array.from({ length: outputsPerExecution }, (_, outputIndex) => ({
            evidence_id: `ev_${index}_${outputIndex}`,
            execution_ref: `execution/${taskId}/${executionId}`,
            locator: { substrate: "inline", text: `Evidence ${index}-${outputIndex}` },
          })),
          submission: null,
        },
        null,
        2,
      )}\n`,
    );
  }
  // Materializer requires authored root to be a Git repository (same as e2e fixtures).
  const harnessRoot = path.join(rootDir, "harness");
  execFileSync("git", ["-C", harnessRoot, "init", "-q"]);
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "p3-perf@example.test"]);
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "P3 Perf"]);
  execFileSync("git", ["-C", harnessRoot, "add", "."]);
  execFileSync("git", ["-C", harnessRoot, "commit", "-q", "-m", "seed p3 wall-clock fixture"]);

  return Math.round(performance.now() - t0);
}


