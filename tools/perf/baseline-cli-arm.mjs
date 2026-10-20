// CLI arm: cold start (daemon stopped -> first command, which must autostart the daemon and
// attach the repo) plus warm common-read sampling that tools/measure-cli-command-timing.mjs does
// not carry (doc show). Warm per-command
// ratios come from the existing measurement, run as a subprocess so its fixture lifecycle stays
// authoritative.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { lastTimingRecord } from "../measure-cli-command-timing.mjs";
import { stats, round3 } from "./baseline-stats.mjs";
import {
  PROBE_REPO_ID,
  bindFixtureRealm,
  failureDetail,
  initializeFixtureRepo,
  invoke,
  makeCliFixture,
  stopFixtureDaemon,
  submitProbeDoc,
} from "./baseline-fixture.mjs";

function latestAttachDurations(userRoot, repoId, limit = 12) {
  const logDir = path.join(userRoot, "logs");
  if (!existsSync(logDir)) return [];
  const durations = [];
  for (const name of readdirSync(logDir).sort()) {
    if (!name.endsWith(".jsonl") && name !== "daemon-default.log") continue;
    for (const line of readFileSync(path.join(logDir, name), "utf8").split("\n")) {
      if (!line.includes('"event":"repo_attach_completed"')) continue;
      try {
        const row = JSON.parse(line);
        if (row.repoId === repoId && Number.isFinite(row.durationMs)) durations.push(round3(row.durationMs));
      } catch {
        // A malformed line in a fixture log is not measurement data; skipping it is the only
        // honest option and the count is reported alongside.
      }
    }
  }
  return durations.slice(-limit);
}

function timingPhases(record) {
  if (!record) return null;
  return {
    totalMs: round3(record.totalMs),
    phases: Object.fromEntries(Object.entries(record.phases ?? {}).map(([key, value]) => [key, round3(value)])),
    daemonRequests: record.daemonRequests ?? [],
  };
}

async function timeCommand(fixture, argv) {
  const result = invoke(fixture, argv, { timing: true });
  if (result.status !== 0) throw new Error(`${argv.join(" ")} exited ${result.status}: ${failureDetail(result)}`);
  return { wallMs: round3(result.wallMs), record: timingPhases(lastTimingRecord(result.stderr ?? "")) };
}

export async function runCliArm({ rootDir, outDir, coldCycles = 5, docSamples = 10, rounds, samples, log }) {
  // 1. Warm per-command measurement through the maintained harness. Its fixture drives the
  // compiled dist CLI, which refuses daemon-routed commands from a linked worktree
  // (cli_entry_not_canonical by design); where that applies the committed ratchet is cited
  // instead and the compiled-entry numbers live in its nightly lane.
  const warmMeasurement = await runCompiledTimingMeasurement(rootDir, outDir, rounds, samples, log);
  const ratchetPath = path.join(rootDir, "tools/gates/cli-command-timing.json");
  const ratchet = JSON.parse(readFileSync(ratchetPath, "utf8"));

  // 2. Cold start on a fresh fixture: every cycle stops the daemon and times the first command
  // (autostart + attach included), then a warm control of the same command.
  const fixture = makeCliFixture(rootDir);
  const realm = await bindFixtureRealm(fixture);
  try {
    await initializeFixtureRepo(fixture);
    const taskListArgv = ["--json", "task", "list"];
    const cold = [],
      warmControl = [],
      coldPhases = [];
    for (let cycle = 0; cycle < coldCycles; cycle += 1) {
      await stopFixtureDaemon(fixture);
      const coldRun = await timeCommand(fixture, taskListArgv);
      cold.push(coldRun.wallMs);
      coldPhases.push(coldRun.record);
      const warmRun = await timeCommand(fixture, taskListArgv);
      warmControl.push(warmRun.wallMs);
      log(`[cli] cold cycle ${cycle + 1}/${coldCycles}: cold=${coldRun.wallMs}ms warm=${warmRun.wallMs}ms`);
    }
    const attachDurations = latestAttachDurations(fixture.userRoot, PROBE_REPO_ID);

    // 3. doc show: the task brief's third read command, timed warm on the same fixture daemon.
    // A fresh task package only has worktree documents; the canonical read the CLI serves needs
    // one real doc submit first (the same doc-submit action the GUI resident fixture uses).
    const docShow = [];
    const canonicalDocPath = await submitProbeDoc(fixture);
    for (let index = 0; index < docSamples; index += 1) {
      const run = await timeCommand(fixture, ["--json", "doc", "show", "--path", canonicalDocPath]);
      docShow.push(run.wallMs);
    }

    return {
      schema: "perf-baseline-cli-arm/v1",
      measuredAt: new Date().toISOString(),
      cliEntry:
        "packages/cli/src/index.ts (source entry; the compiled dist entry refuses daemon-routed commands from a linked worktree by design)",
      warm: {
        measurement: warmMeasurement,
        committedRatchet: {
          source: "tools/gates/cli-command-timing.json",
          basisRevision: ratchet.basisRevision,
          measuredAt: ratchet.measuredAt ?? null,
          limits: ratchet.limits,
        },
      },
      coldStart: {
        cycles: coldCycles,
        command: "ha --json task list (daemon autostart + repo attach included)",
        coldWallMs: stats(cold),
        warmControlWallMs: stats(warmControl),
        coldCliTotalMs: stats(coldPhases.map((row) => row?.totalMs).filter(Number.isFinite)),
        coldDaemonRoundTripMs: stats(coldPhases.map((row) => row?.phases?.daemonRoundTrip).filter(Number.isFinite)),
        attachDurationMsFromLog: attachDurations,
        attachP50Ms: stats(attachDurations).p50Ms,
      },
      docShow: { measured: true, path: canonicalDocPath, samples: docSamples, wallMs: stats(docShow) },
    };
  } finally {
    await stopFixtureDaemon(fixture);
    await realm.close();
    rmSync(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

// The compiled timing harness only runs where the dist CLI is allowed to talk to a daemon: the
// canonical checkout and CI. In a linked worktree the guard refuses it, which is recorded rather
// than bypassed.
async function runCompiledTimingMeasurement(rootDir, outDir, rounds, samples, log) {
  const distEntry = path.join(rootDir, "packages/cli/dist/cli/src/index.js");
  const worktreeGuarded = existsSync(distEntry) && realpathSync(distEntry).split(path.sep).includes(".worktrees");
  if (!existsSync(distEntry))
    return { ran: false, reason: "compiled CLI dist is not built (npm run build -w @harness-anything/cli)" };
  if (worktreeGuarded)
    return {
      ran: false,
      reason:
        "compiled CLI dist entry is a linked-worktree build; the cli_entry_not_canonical guard refuses its daemon-routed commands",
    };
  const cliTimingJson = path.join(outDir, "cli-command-timing.json");
  await runSubprocess(
    log,
    [process.execPath, path.join(rootDir, "tools/measure-cli-command-timing.mjs"), "--out", cliTimingJson],
    rounds && samples ? ["--rounds", String(rounds), "--samples", String(samples)] : [],
    rootDir,
  );
  const cliTiming = JSON.parse(readFileSync(cliTimingJson, "utf8"));
  return {
    ran: true,
    document: "cli-command-timing.json",
    commands: Object.fromEntries(
      Object.entries(cliTiming.commands).map(([id, row]) => [
        id,
        { totalMs: row.totalMs, ratio: row.ratio, daemonHandlerMs: row.daemonHandlerMs, localMs: row.localMs },
      ]),
    ),
  };
}

export function runSubprocess(log, command, extraArgs = [], cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...extraArgs], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of String(chunk).split("\n").filter(Boolean)) log(`[cli-timing] ${line}`);
    });
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) log(`[cli-timing:err] ${line}`);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`subprocess exited ${code}`))));
  });
}
