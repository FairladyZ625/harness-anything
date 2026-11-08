#!/usr/bin/env node
/**
 * Flaky-test ledger (dec_25B3C380F6FB9D4D4A1E27921E CH2).
 *
 * Counting rule. A rerun that turns green is recorded by GitHub as a successful run, so counting
 * failed runs undercounts flakiness. This ledger counts the opposite way: a run is "rerun-green"
 * when its latest attempt concluded `success` and `run_attempt > 1`; its tests are the ones that
 * failed in attempt 1.
 *
 * Window and denominator. The window is the last `--days` days (default 14) by run `created_at`
 * (UTC date, inclusive). The rerun-green rate is rerun-green runs / decided runs, where a decided
 * run is a completed run of the workflow whose latest conclusion is `success` or `failure`;
 * cancelled, skipped and still-running runs are excluded from both sides (superseded PR runs are
 * cancelled by the workflow's concurrency group and say nothing about flakiness).
 *
 * Reading. Everything goes through the `gh` CLI (its own authentication locally; on Actions the
 * workflow token with `actions: read`):
 *   - runs: GET repos/{repo}/actions/workflows/{workflow}/runs?created=>=DATE, 100 per page,
 *     following pages until a short page or `--limit` runs;
 *   - attempt 1 jobs: GET repos/{repo}/actions/runs/{id}/attempts/1/jobs (100 per page, enough for
 *     rewrite-ci's job count) keeping jobs whose conclusion is `failure`;
 *   - logs: GET repos/{repo}/actions/jobs/{job}/logs (`--allow-escape-sequences`), the plain text
 *     `gh run view {id} --attempt 1 --log-failed` also shows.
 *
 * Missing data is marked, never dropped. GitHub keeps job logs for the repository's retention
 * period (90 days by default); an expired or unreadable log yields a `log-unavailable` row naming
 * the job. A readable log without a node:test summary block (a build, vitest or Windows smoke
 * failure) yields an `unparsed` row naming the job, so the run still counts and its job is visible.
 *
 * Deduplication. A test counts once per run: rows are keyed by (run id, file, test name), so the
 * runner reprinting a failure, or one test failing in two shards, does not inflate the count. The
 * per-file count in the report is the number of distinct runs.
 *
 * Outputs: <out>/flaky-ledger.md (readable report, also appended to the Actions step summary) and
 * <out>/flaky-ledger.tsv (run_id, date, job, status, file, test).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Extract failing tests from a node:test job log. The runner's summary block names each one as
 * `test at <file>:<line>:<column>` followed by `✖ <name> (<ms>ms)`.
 */
export function parseFailingTests(log) {
  const lines = log.split(/\r?\n/u).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/u, ""));
  const failures = [];
  for (let index = 0; index < lines.length; index += 1) {
    const at = /^test at (.+?):\d+:\d+$/u.exec(lines[index].trim());
    if (!at) continue;
    const name = /^✖ (.+?)(?: \([\d.]+m?s\))?$/u.exec(lines[index + 1]?.trim() ?? "");
    const file = at[1].replace(/^(?:\.\.\/)+/u, "/").replace(/^.*?\/harness-anything\/harness-anything\//u, "");
    failures.push({ file, test: name?.[1] ?? "(unnamed)" });
  }
  const unique = new Map(failures.map((failure) => [`${failure.file}\u0000${failure.test}`, failure]));
  return [...unique.values()];
}

/** One ledger row per first-attempt failure; a failed job with no parseable test names itself. */
export function attemptFailures(run, jobs) {
  const rows = jobs.flatMap((job) => {
    const tests = job.log === null ? [] : parseFailingTests(job.log);
    const status = job.log === null ? "log-unavailable" : tests.length ? "test" : "unparsed";
    const failures = tests.length ? tests : [{ file: `(job:${job.name})`, test: "" }];
    return failures.map((row) => ({ ...row, status, runId: run.id, date: run.createdAt.slice(0, 10), job: job.name }));
  });
  const unique = new Map(rows.map((row) => [`${row.runId}\u0000${row.file}\u0000${row.test}`, row]));
  return [...unique.values()];
}

export function aggregate(rows) {
  const byFile = new Map();
  for (const row of rows) {
    const entry = byFile.get(row.file) ?? {
      file: row.file,
      runs: new Set(),
      lastDate: "",
      tests: new Set(),
      status: row.status,
    };
    entry.runs.add(row.runId);
    if (row.date > entry.lastDate) entry.lastDate = row.date;
    if (row.test) entry.tests.add(row.test);
    byFile.set(row.file, entry);
  }
  return [...byFile.values()]
    .map((entry) => ({
      file: entry.file,
      status: entry.status,
      count: entry.runs.size,
      lastDate: entry.lastDate,
      tests: [...entry.tests],
    }))
    .sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate) || a.file.localeCompare(b.file));
}

export function renderReport({ repository, decidedRuns, rerunGreenRuns, rows, generatedAt, since }) {
  const rate = decidedRuns ? ((rerunGreenRuns / decidedRuns) * 100).toFixed(1) : "0.0";
  const table = aggregate(rows).map(
    (entry) =>
      `| ${entry.count} | ${entry.lastDate} | \`${entry.file}\` | ${entry.status} | ` +
      `${entry.tests.map((name) => name.replaceAll("|", "\\|")).join("<br>")} |`,
  );
  return [
    `# Flaky-test ledger — ${repository} rewrite-ci`,
    "",
    `Generated ${generatedAt}; window: runs created since ${since}. A run counts when its latest attempt ` +
      "succeeded after more than one attempt; the tests listed failed in attempt 1.",
    "",
    `**Rerun-green rate: ${rate}%** (${rerunGreenRuns} of ${decidedRuns} runs that concluded success or failure).`,
    "",
    "Status `unparsed` means the job log had no node:test summary (build, vitest or smoke failure); " +
      "`log-unavailable` means the log expired or could not be read.",
    "",
    "| Runs | Last seen | Test file | Status | Failing tests in attempt 1 |",
    "| ---: | --- | --- | --- | --- |",
    ...(table.length ? table : ["| 0 | | (none) | | |"]),
    "",
  ].join("\n");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function listRuns(repository, workflow, since, limit) {
  const runs = [];
  for (let page = 1; runs.length < limit; page += 1) {
    const query = `per_page=100&page=${page}&created=>=${since}`;
    const body = JSON.parse(gh(["api", `repos/${repository}/actions/workflows/${workflow}/runs?${query}`]));
    const batch = body.workflow_runs ?? [];
    for (const run of batch)
      runs.push({
        id: run.id,
        attempt: run.run_attempt,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.created_at,
      });
    if (batch.length < 100) break;
  }
  return runs.slice(0, limit);
}

function firstAttemptFailedJobs(repository, runId) {
  const body = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${runId}/attempts/1/jobs?per_page=100`]));
  return (body.jobs ?? [])
    .filter((job) => job.conclusion === "failure")
    .map((job) => ({ name: job.name, log: jobLog(repository, job.id) }));
}

/** An expired or unreadable log is reported as `null`, which the ledger marks `log-unavailable`. */
function jobLog(repository, jobId) {
  try {
    return gh(["api", "--allow-escape-sequences", `repos/${repository}/actions/jobs/${jobId}/logs`]);
  } catch (error) {
    process.stderr.write(
      `log-unavailable job ${jobId}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
    );
    return null;
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const repository = option("repo", process.env.GITHUB_REPOSITORY),
    workflow = option("workflow", "rewrite-ci.yml"),
    days = Number(option("days", "14")),
    limit = Number(option("limit", "1000")),
    out = option("out", "tmp/flaky-ledger");
  if (!repository) throw new Error("--repo <owner/name> or GITHUB_REPOSITORY is required");
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const decided = listRuns(repository, workflow, since, limit).filter(
    (run) => run.status === "completed" && (run.conclusion === "success" || run.conclusion === "failure"),
  );
  const rerunGreen = decided.filter((run) => run.attempt > 1 && run.conclusion === "success");
  const rows = rerunGreen.flatMap((run) => attemptFailures(run, firstAttemptFailedJobs(repository, run.id)));
  const report = renderReport({
    repository,
    decidedRuns: decided.length,
    rerunGreenRuns: rerunGreen.length,
    rows,
    generatedAt: new Date().toISOString(),
    since,
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "flaky-ledger.md"), report);
  writeFileSync(
    path.join(out, "flaky-ledger.tsv"),
    [
      "run_id\tdate\tjob\tstatus\tfile\ttest",
      ...rows.map((row) => [row.runId, row.date, row.job, row.status, row.file, row.test].join("\t")),
    ]
      .join("\n")
      .concat("\n"),
  );
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
  process.stdout.write(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
