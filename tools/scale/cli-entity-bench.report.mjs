/**
 * Coverage and result shaping for tools/scale/cli-entity-bench.mjs: the registry-derived coverage
 * matrix, compact result rows, per-metric percentiles and the Markdown renderings.
 */
import { spawnSync } from "node:child_process";
import { percentile } from "../measure-cli-command-timing.mjs";
import { commandTable, registryId } from "./cli-entity-bench.commands.mjs";
import { brief } from "./cli-entity-bench.workload.mjs";

export async function coverage() {
  const { thinCliCommands } = await import("../../packages/daemon/src/protocol/daemon-protocol.contract.ts");
  const { clientLocalCommands } = await import("../../packages/cli/src/cli/thin-command-help.ts");
  const registry = [
    ...thinCliCommands.map(({ id, path: words, method, commandClass }) => ({
      id,
      path: words.join(" "),
      method,
      commandClass,
    })),
    ...clientLocalCommands.map(({ usage }) => ({
      id: usage
        .split(" ")
        .slice(1)
        .filter(
          (word, index, words) =>
            !/^[-[<]/u.test(word) && words.slice(0, index).every((prior) => !/^[-[<]/u.test(prior)),
        )
        .join("-"),
      path: usage,
      method: "client-local",
    })),
    ...["capabilities", "version", "help", "events-tail", "backup", "restore-drill"].map((id) => ({
      id,
      method: "client-local",
    })),
  ];
  const measured = new Map();
  for (const [metric, build] of commandTable) {
    const row = measured.get(registryId(metric)) ?? { metrics: [], reason: null };
    if (typeof build === "string") row.reason = build;
    else row.metrics.push(metric);
    measured.set(registryId(metric), row);
  }
  return registry.map((command) => ({
    ...command,
    ...(measured.get(command.id) ?? { metrics: [], reason: "UNMAPPED" }),
  }));
}

export function matrixMarkdown(rows) {
  const lines = [
    "| command id | path | method | class | measured metrics | not measured because |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows)
    lines.push(
      `| ${row.id} | ${row.path ?? ""} | ${row.method} | ${row.commandClass ?? ""} | ${row.metrics.join(", ")} | ${row.reason ?? ""} |`,
    );
  const counted = (test) => rows.filter(test).length;
  lines.push(
    "",
    `${rows.length} commands: ${counted((row) => row.metrics.length)} measured, ` +
      `${counted((row) => !row.metrics.length && row.reason !== "UNMAPPED")} excluded, ${counted((row) => row.reason === "UNMAPPED")} unmapped.`,
  );
  return lines.join("\n");
}

export const countBy = (rows, key) =>
  rows.reduce((counts, row) => ({ ...counts, [key(row)]: (counts[key(row)] ?? 0) + 1 }), {});

// Rows keep the receipt identity and CLI phases; full stdout stays out of the results file.
export function compactRow(row) {
  const { stdout, stderr, receipt, timing, startedAt: _at, seed: _seed, expect: _expect, ...rest } = row;
  // A CLI process succeeded when it exited 0 (explain, help and capabilities carry no `ok` field).
  return {
    ...rest,
    arm: row.arm ?? "cli",
    ...(receipt ? brief(receipt) : {}),
    ...(row.exit === undefined ? {} : { ok: row.exit === 0 }),
    stdoutBytes: stdout?.length,
    stderrTail: row.exit === 0 ? undefined : stderr?.slice(-400),
    timing: timing
      ? { totalMs: timing.totalMs, phases: timing.phases, daemonRequests: timing.daemonRequests }
      : undefined,
  };
}

export function summarize(rows) {
  const groups = new Map();
  for (const row of rows)
    if (row.wallMs !== null)
      groups.set(`${row.arm}|${row.metric}`, [...(groups.get(`${row.arm}|${row.metric}`) ?? []), row]);
  return [...groups].map(([key, group]) => {
    const [arm, metric] = key.split("|"),
      wall = group.map((row) => row.wallMs),
      rpcMs = group.map((row) => row.timing?.phases?.daemonRoundTrip).filter(Number.isFinite);
    return {
      arm,
      metric,
      n: group.length,
      ok: group.filter((row) => row.ok === true).length,
      codes: countBy(
        group.filter((row) => row.ok !== true),
        (row) => row.code ?? row.error ?? `exit ${row.exit}`,
      ),
      p50: percentile(wall, 0.5),
      p95: percentile(wall, 0.95),
      p99: percentile(wall, 0.99),
      max: Math.max(...wall),
      ...(rpcMs.length
        ? { daemonRoundTripP50: percentile(rpcMs, 0.5), daemonRoundTripP95: percentile(rpcMs, 0.95) }
        : {}),
    };
  });
}

export function summaryMarkdown(result) {
  const cell = (value) => (Number.isFinite(value) ? value.toFixed(1) : "");
  return [
    `# cli-entity-bench ${result.params.tasks} tasks @ ${result.source.sha.slice(0, 12)}`,
    "",
    `elapsed ${(result.elapsedMs / 1000).toFixed(0)} s; oracles: ${Object.values(result.oracles)
      .map((o) => `${o.id} ${o.verdict}`)
      .join(", ")}; ` +
      `negative controls: ${result.negativeControls.filter((c) => c.passed).length}/${result.negativeControls.length} detected`,
    "",
    "```json",
    JSON.stringify({ phases: result.phases, counts: result.counts }, null, 1),
    "```",
    "",
    "| arm | metric | n | ok | p50 ms | p95 ms | p99 ms | max ms | daemon RPC p50 | failures |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...result.summary.map(
      (row) =>
        `| ${row.arm} | ${row.metric} | ${row.n} | ${row.ok} | ${cell(row.p50)} | ${cell(row.p95)} | ${cell(row.p99)} | ${cell(row.max)} | ` +
        `${cell(row.daemonRoundTripP50)} | ${Object.entries(row.codes)
          .map(([code, count]) => `${code}×${count}`)
          .join(" ")} |`,
    ),
  ].join("\n");
}

export function compareMarkdown(small, large) {
  const index = new Map(small.summary.map((row) => [`${row.arm}|${row.metric}`, row]));
  const rows = large.summary
    .flatMap((row) => {
      const base = index.get(`${row.arm}|${row.metric}`);
      return base && base.p50 > 0 ? [{ ...row, base, ratio: row.p50 / base.p50 }] : [];
    })
    .sort((left, right) => right.ratio - left.ratio);
  return [
    `| arm | metric | p50 @${small.params.tasks} | p50 @${large.params.tasks} | ratio | p95 @${small.params.tasks} | p95 @${large.params.tasks} |`,
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (row) =>
        `| ${row.arm} | ${row.metric} | ${row.base.p50.toFixed(1)} | ${row.p50.toFixed(1)} | ${row.ratio.toFixed(2)} | ${row.base.p95.toFixed(1)} | ${row.p95.toFixed(1)} |`,
    ),
  ].join("\n");
}

// Inside the container there is no .git, so --docker passes the host's identity in the environment.
export function sourceIdentity() {
  if (process.env.CLI_ENTITY_BENCH_SOURCE) return JSON.parse(process.env.CLI_ENTITY_BENCH_SOURCE);
  const read = (...gitArgs) => spawnSync("git", gitArgs, { encoding: "utf8" }).stdout?.trim() || null;
  return {
    sha: read("rev-parse", "HEAD") ?? "unverified",
    base: read("merge-base", "HEAD", "origin/main"),
    dirty: Boolean(read("status", "--porcelain")),
  };
}
