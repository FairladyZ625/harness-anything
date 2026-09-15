// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctorInvocation, extractDoctorCommands, runDoctor } from "../src/cli/thin-command-doctor.ts";
import { renderDoctorHealth } from "../src/cli/thin-command-doctor-health.ts";
import { emit, main } from "../src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function captureConsole(run: () => Promise<number> | number): Promise<{ exit: number; lines: string[] }> {
  const lines: string[] = [],
    log = console.log,
    error = console.error;
  console.log = (value: unknown) => {
    lines.push(String(value));
  };
  console.error = console.log;
  return Promise.resolve()
    .then(run)
    .then((exit) => ({ exit, lines }))
    .finally(() => {
      console.log = log;
      console.error = error;
    });
}

function fixtureRepo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-doctor-"));
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

test("doctor extracts ha commands from fences, prompts, and inline code spans only", () => {
  const source = [
    "# Doc",
    "",
    "ha task list in prose is not a command reference.",
    "",
    "```bash",
    "$ ha task list --json",
    "ha task show task_1   # comment suffix",
    "ha settings read && ha task list",
    "npm run build",
    "```",
    "",
    "Run `ha daemon status` or `ha fact list` inline.",
    "An indented",
    "    ha task list",
    "block is not fenced code.",
  ].join("\n");
  const commands = extractDoctorCommands(source);
  assert.deepEqual(
    commands.map(({ line, command }) => ({ line, command })),
    [
      { line: 6, command: "ha task list --json" },
      { line: 7, command: "ha task show task_1   # comment suffix" },
      { line: 8, command: "ha settings read && ha task list" },
      { line: 12, command: "ha daemon status" },
      { line: 12, command: "ha fact list" },
    ],
  );
});

test("doctor reports stale invocations per file:line and accepts the live surface", () => {
  const root = fixtureRepo({
    "harness/context/ops.md": [
      "# Runbook",
      "```bash",
      "ha task list --json",
      "ha runtime run --agent worker-a --task task_1",
      "```",
      "Inspect with `ha status`, check `ha daemon status`.",
    ].join("\n"),
    "AGENTS.md": "Follow `ha task show task_1` for details.\n",
  });
  try {
    const report = runDoctor(root);
    assert.equal(report.checked, 5);
    assert.deepEqual(
      report.findings.map(({ path: file, line, code }) => `${file}:${line}:${code}`),
      ["harness/context/ops.md:4:missing_field", "harness/context/ops.md:6:command_not_found"],
    );
    const reasons = report.findings.map(({ reason }) => reason);
    assert.match(reasons[0] ?? "", /runtime run/u);
    assert.match(reasons[1] ?? "", /command domain/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor skips placeholder templates and shell substitutions instead of misparsing them", () => {
  const root = fixtureRepo({
    "docs-release/guide.md": [
      "```bash",
      "ha init --name <name>",
      "ha agent run $AGENT --task task_1",
      "ha task list",
      "```",
    ].join("\n"),
  });
  try {
    const report = runDoctor(root);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ha doctor defaults to health mode and keeps commands mode explicit", () => {
  const bare = doctorInvocation(["doctor"]),
    health = doctorInvocation(["doctor", "health", "--json", "--root", "/tmp"]),
    commands = doctorInvocation(["doctor", "commands", "--root", "/tmp"]);
  assert.ok(bare.ok);
  if (bare.ok) assert.equal(bare.mode, "health");
  assert.ok(health.ok);
  if (health.ok) {
    assert.equal(health.mode, "health");
    assert.equal(health.rootDir, "/tmp");
  }
  assert.ok(commands.ok);
  if (commands.ok) assert.equal(commands.mode, "commands");
  assert.equal(doctorInvocation(["doctor", "bogus"]).ok, false);
});

test("ha doctor commands exits 0 with the ok line on a clean fixture and 1 with findings", async () => {
  const clean = fixtureRepo({
      "harness/governance/rules.md": "Use `ha task list` and `ha decision list`.\n",
    }),
    stale = fixtureRepo({ "docs-release/old.md": "Run `ha status` first.\n" });
  try {
    const ok = await captureConsole(() => main(["doctor", "commands", "--root", clean]));
    assert.equal(ok.exit, 0);
    assert.deepEqual(ok.lines, ["doctor: ok (2 commands checked)"]);
    const bad = await captureConsole(() => main(["doctor", "commands", "--root", stale]));
    assert.equal(bad.exit, 1);
    assert.match(bad.lines[0] ?? "", /^docs-release\/old\.md:1 — ha status — command_not_found:/u);
    assert.match(bad.lines[1] ?? "", /^doctor: 1 stale command reference\(s\) \(1 commands checked\)$/u);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

test("ha doctor rejects unexpected arguments as a usage failure", async () => {
  const { exit, lines } = await captureConsole(() => main(["doctor", "bogus", "--root", repoRoot]));
  assert.equal(exit, 2);
  assert.match(lines[0] ?? "", /code=invalid_field/u);
  assert.match(lines[0] ?? "", /ha doctor \[commands\|health\]/u);
});

test("ha doctor smoke-runs against the repository's own authored docs", async () => {
  const { exit, lines } = await captureConsole(() => main(["doctor", "commands", "--root", repoRoot]));
  assert.ok(exit === 0 || exit === 1, `unexpected exit ${exit}`);
  const summary = lines.at(-1) ?? "";
  assert.match(summary, /^doctor: (ok|[0-9]+ stale command reference\(s\)) \([0-9]+ commands checked\)$/u);
  for (const finding of lines.slice(0, -1)) assert.match(finding, /^.+\.md:[0-9]+ — ha .+ — [a-z_]+: .+$/u);
});

for (const json of [false, true]) {
  test(`doctor health preserves failed receipt code and next (json=${json})`, async () => {
    const receipt = {
      schema: "command-receipt/v2",
      ok: false,
      outcome: "op_rejected",
      command: "doctor-health",
      code: "repo_unavailable",
      error: { code: "repo_unavailable", hint: "Center unavailable." },
      next: [{ action: "ha daemon status", reason: "Inspect the center." }],
    };
    const result = await captureConsole(() => renderDoctorHealth(receipt, json, emit));
    assert.equal(result.exit, 1);
    assert.match(result.lines.join("\n"), /repo_unavailable/u);
    assert.match(result.lines.join("\n"), /ha daemon status/u);
  });
  for (const status of ["ok", "warn", "indeterminate", "fail"]) {
    test(`doctor health ${status} exit and rendering (json=${json})`, async () => {
      const result = await captureConsole(() =>
        renderDoctorHealth(
          {
            schema: "doctor-health/v1",
            outcome: "applied",
            ok: true,
            scope: { repoId: "center", note: "center-local" },
            checks: [{ id: "wip-pressure", status, summary: "observed capacity", count: 1, next: "ha task list" }],
          },
          json,
          emit,
        ),
      );
      assert.equal(result.exit, status === "fail" ? 1 : 0);
      assert.match(result.lines.join("\n"), /observed capacity/u);
      if (json) assert.equal(JSON.parse(result.lines[0]!).ok, status !== "fail");
    });
  }
}
