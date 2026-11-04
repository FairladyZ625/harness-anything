// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { cliHelpTiers } from "@harness-anything/preset/internal/preset-command-contract";
import { thinCliCommands } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { renderThinHelp } from "../src/cli/thin-command.ts";

const taskRows = thinCliCommands.filter(({ path }) => path[0] === "task");
const tierOf = (id: string) => taskRows.find((row) => row.id === id)?.helpTier;
const rowsIn = (tier: string) => taskRows.filter((row) => row.helpTier === tier);
const common = rowsIn("common");
const advanced = rowsIn("advanced");
const maintenance = rowsIn("maintenance");
const defaultHelp = () => renderThinHelp([], "task");
const allHelp = () => renderThinHelp([], "task", undefined, [], true);

test("every visible task command carries exactly one help tier", () => {
  assert.equal(taskRows.length, 37);
  assert.deepEqual(
    taskRows.map(({ id }) => id).sort(),
    [...common, ...advanced, ...maintenance].map(({ id }) => id).sort(),
  );
  for (const row of taskRows) {
    assert.ok(
      cliHelpTiers.includes(row.helpTier),
      `${row.id}: helpTier ${String(row.helpTier)} is not a declared tier`,
    );
  }
  assert.deepEqual([common.length, advanced.length, maintenance.length], [11, 18, 8]);
});

test("tiers pin to the frequency-driven layer sets", () => {
  assert.deepEqual(common.map(({ id }) => id).sort(), [
    "task-artifact-add",
    "task-complete",
    "task-create",
    "task-dispatches",
    "task-list",
    "task-progress-append",
    "task-push",
    "task-read-set",
    "task-show",
    "task-start",
    "task-submit",
  ]);
  for (const id of ["task-start", "task-progress-append", "task-submit", "task-complete", "task-create"])
    assert.equal(tierOf(id), "common", `${id} belongs to the acceptance loop`);
  for (const id of ["task-transition", "task-rework", "task-review-execution", "task-review-consent"])
    assert.equal(tierOf(id), "advanced", `${id} is review/recovery`);
  for (const id of ["task-assign", "task-delete", "task-rematerialize", "task-witness-rerun"])
    assert.equal(tierOf(id), "maintenance", `${id} is maintenance`);
});

test("default help lists the common layer in full and only names the rest", () => {
  const help = defaultHelp();
  for (const row of common) {
    assert.ok(help.includes(row.usage), `${row.id}: default help must show the common usage`);
    assert.ok(help.includes(row.summary), `${row.id}: default help must show the common summary`);
  }
  for (const row of [...advanced, ...maintenance]) {
    assert.ok(!help.includes(row.usage), `${row.id}: default help must not inline a non-common usage`);
    assert.ok(help.includes(`  ha ${row.path.join(" ")}`), `${row.id}: default help must still name the command`);
  }
  assert.match(help, /Advanced \(18\) — ha task --help --all lists their options:/u);
  assert.match(help, /Maintenance \(8\) — ha task --help --all lists their options:/u);
  assert.match(help, /Each command answers ha <command> --help with its full option reference\./u);
  // Negative control for the tier filter: the advanced transition reference must be absent here.
  assert.ok(!help.includes("ha task transition <task-id>"), "default help must not render the transition reference");
});

test("--all renders the complete catalog with option detail", () => {
  const help = allHelp();
  for (const row of taskRows) assert.ok(help.includes(row.usage), `${row.id}: --all must include its usage`);
  assert.match(help, /ha task delete \[--soft <soft>\].*--soft — optional; value; format: <task-id>/su);
  assert.match(help, /Commands for task:/u);
  assert.doesNotMatch(help, /--help --all lists their options/u);
});

test("a named command keeps its full detail page regardless of tier", () => {
  const rework = taskRows.find(({ id }) => id === "task-rework");
  assert.ok(rework);
  const detail = renderThinHelp([], "task", "ha task rework");
  assert.match(detail, /^Command ha task rework:/mu);
  assert.ok(detail.includes(rework.usage), "detail page must render the full rework usage");
  assert.match(detail, /--reason/u);
  const allFlagDetail = renderThinHelp([], "task", "ha task rematerialize --all");
  assert.match(allFlagDetail, /^Command ha task rematerialize:/mu);
  assert.match(allFlagDetail, /--dry-run/u);
});

test("the real CLI meets the measured 60% reduction target", { timeout: 120_000 }, () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const render = (args: string[]) => {
    const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 90_000,
    });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const defaults = render(["task", "--help"]);
  const all = render(["task", "--help", "--all"]);
  assert.ok(Buffer.byteLength(all) > 15_000, `--all must render the full catalog, got ${Buffer.byteLength(all)} bytes`);
  assert.ok(
    Buffer.byteLength(defaults) <= Buffer.byteLength(all) * 0.4,
    `default ${Buffer.byteLength(defaults)} B must be <= 40% of --all ${Buffer.byteLength(all)} B`,
  );
});
