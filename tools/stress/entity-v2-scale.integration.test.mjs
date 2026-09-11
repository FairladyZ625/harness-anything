// harness-test-tier: integration
// harness-test-file-timeout: none
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { makeTaskEventReader, makeTaskProjection } from "../../packages/kernel/src/index.ts";
import { main as cliMain } from "../../packages/cli/src/index.ts";
import { git } from "../../packages/cli/test/daemon-multi-repo-lifecycle-cli.fixtures.ts";
import { realizedTaskPlan } from "../fixtures/task-plan.mjs";
import {
  assertBytes,
  directoryBytes,
  fixture,
  frame,
  profiling,
  readWorkloadConfig,
  resourceSnapshot,
  summarize,
  syntheticBinary,
} from "./entity-v2-scale.fixture.mjs";
import { generateEventStream } from "./entity-v2-scale.generator.mjs";

const kind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
const config = readWorkloadConfig();
const evidence = (receipt) => JSON.parse(receipt.evidence);
const skip =
  process.platform !== "linux"
    ? "requires the isolated Linux measurement target"
    : config.enabled === true
      ? false
      : "workload disabled: tools/stress/entity-v2-scale.workload.json enabled=false";

/**
 * A projection follower on its own thread. `finish` names the final revision and whether to digest, and gives
 * up at `withinMs`: the follower is stopped and the error names how far replay got.
 */
function follower(label, rootDir, repoId, projectionPath) {
  const worker = new Worker(new URL("./entity-v2-scale.projection-worker.mjs", import.meta.url), {
    workerData: { rootDir, repoId, projectionPath },
  });
  let reached = null;
  const settled = new Promise((resolve) => {
    worker.on("message", ({ progress, ...message }) => {
      if (!progress) return resolve(message);
      reached = message;
      frame("follower-progress", { label, ...message });
    });
    worker.once("error", (error) => resolve({ ok: false, error: error.message }));
    worker.once("exit", (code) => resolve({ ok: false, error: `${label} follower exited ${code} before reporting` }));
  });
  return {
    finish: async (revision, digest, withinMs) => {
      worker.postMessage({ revision, digest });
      let timer;
      const expired = new Promise((resolve) => {
        const error = () => `stage budget: ${label} follower reached ${JSON.stringify(reached)} of ${revision}`;
        timer = setTimeout(() => resolve({ ok: false, error: error() }), Math.max(0, withinMs));
      });
      const result = await Promise.race([settled, expired]);
      clearTimeout(timer);
      if (result.ok) return result;
      await worker.terminate();
      throw new Error(result.error);
    },
    stop: () => worker.terminate(),
  };
}

test(`V2 scale tier: ${config.targetEvents} generated events`, { skip, timeout: config.stageBudgetMs }, async () => {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  // Phases stop cleanly before the dispatcher's per-file watchdog, keeping room to report and clean up.
  const remainingMs = () => config.stageBudgetMs - 45_000 - elapsed();
  const requireBudget = (phase, neededMs) => {
    if (remainingMs() < neededMs)
      throw new Error(`stage budget: ${Math.round(remainingMs())} ms left before ${phase}, needs ${neededMs} ms`);
  };
  const profile = profiling(config.profileDir);
  const f = fixture(config.seed, undefined, profile);
  const failures = [],
    tier = { targetEvents: config.targetEvents };
  let reader = null,
    hotFollower = null,
    coldFollower = null;
  const guard = (name, operation) => {
    try {
      return operation();
    } catch (error) {
      failures.push({ phase: name, error: error.message });
      frame("failure", failures.at(-1));
      return null;
    }
  };
  const guardAsync = async (name, operation) => {
    try {
      return await operation();
    } catch (error) {
      failures.push({ phase: name, error: error.message });
      frame("failure", failures.at(-1));
      return null;
    }
  };

  // Arm B: one resident Node process reusing loaded CLI modules and a fresh socket per request.
  const inProcess = async (metric, args) => {
    const previous = { ...process.env };
    Object.assign(process.env, f.env);
    const chunks = [],
      errorChunks = [],
      write = process.stdout.write.bind(process.stdout),
      writeError = process.stderr.write.bind(process.stderr),
      // The node:test reporter writes its own binary protocol to these streams and follower frames can
      // land mid-command; only the CLI's console.log receipt is captured, everything else passes through.
      capture = (sink, passthrough) => (chunk, encoding, callback) => {
        if (typeof chunk !== "string" || chunk.startsWith("ENTITY_V2_SCALE\t"))
          return passthrough(chunk, encoding, callback);
        sink.push(chunk);
        if (typeof encoding === "function") encoding();
        else if (typeof callback === "function") callback();
        return true;
      };
    process.stdout.write = capture(chunks, write);
    process.stderr.write = capture(errorChunks, writeError);
    profile?.mark("start", `in-process.${metric}`);
    const commandStarted = performance.now();
    let status = null,
      thrown = null;
    try {
      status = await cliMain(["--root", f.root, "--json", ...args]);
    } catch (error) {
      thrown = error;
    } finally {
      profile?.mark("end", `in-process.${metric}`);
      process.stdout.write = write;
      process.stderr.write = writeError;
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
    const stdout = chunks.join(""),
      stderr = errorChunks.join("");
    let receipt = null;
    try {
      receipt = JSON.parse(stdout);
    } catch {
      /* Parse failures are evidence too. */
    }
    const row = {
      seed: config.seed,
      metric,
      arm: "in-process-reused-modules",
      wallMs: performance.now() - commandStarted,
      exit: status,
      ok: status === 0 && receipt?.ok === true,
      receipt,
      error: thrown?.message ?? null,
      ...(status === 0 && receipt?.ok === true ? {} : { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) }),
    };
    f.rows.push(row);
    if (!row.ok) {
      const { receipt: rejected, ...rest } = row;
      failures.push({ phase: metric, error: JSON.stringify({ ...rest, code: rejected?.code ?? null }).slice(0, 2000) });
      frame("failure", failures.at(-1));
    }
    return row;
  };
  const probeInput = (sample) => {
    const locator = `inputs/probe/${sample}`,
      directory = path.join(f.root, locator),
      text = Buffer.from(`# Probe ${sample}\n`),
      binary = syntheticBinary(90_000 + sample, config.binaryBytes);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "README.md"), text);
    writeFileSync(path.join(directory, "sample.bin"), binary);
    return {
      argv: ["entity", "import", "--kind", kind, "--locator", locator, "--expected-version", "0"],
      text,
      binary,
    };
  };
  const importProbe = (metric, sample) => {
    const { argv, text, binary } = probeInput(sample),
      receipt = f.invoke(metric, argv, { frameRow: false });
    return { receipt, id: evidence(receipt).preview.entityId, text, binary };
  };
  let generatedSamples = null;
  const reckonArgs = (sample) => {
    const { decisionId, taskId } = generatedSamples.decisions[sample % generatedSamples.decisions.length];
    return ["decision", "reckon", decisionId, "--task", taskId];
  };
  try {
    frame("protocol", {
      config,
      cache: "no OS page cache eviction; the daemon starts onto a projection its follower kept current",
      interpretation:
        "arm cli-process includes Node startup and module load per operation; arm in-process-reused-modules " +
        "does not. The two arms are never compared as a speedup.",
      resources: resourceSnapshot(f.parent, "before"),
    });

    f.invoke("setup.init", ["init", "--repo-id", config.repoId, "--person-id", "owner", "--display-name", "Owner"]);
    reader = makeTaskEventReader({ rootDir: f.root, repoId: config.repoId });
    const entryBackup = f.invoke("v2.backup", ["backup", path.join(f.parent, "entry-backup")], { offline: true });
    f.check("v2.generation-two-before-workload", () => {
      assert.equal(reader.ledgerMetadata().generation, 2, "reader generation");
      assert.equal(entryBackup.manifest?.sqlite?.generation, 2, JSON.stringify(entryBackup.manifest));
    });

    // Generation writes the ledger directly, so the daemon is stopped. One follower keeps the daemon's own
    // projection current while events land; a second builds an independent projection from empty.
    await f.stopDaemon("generation.daemon-stop");
    hotFollower = follower("hot", f.root, config.repoId);
    coldFollower = follower("cold", f.root, config.repoId, path.join(f.parent, "cold-follower.sqlite"));
    await profile?.startProcess();
    profile?.mark("start", "generation");
    const generated = await generateEventStream({
      rootDir: f.root,
      repoId: config.repoId,
      seed: config.seed,
      targetEvents: config.targetEvents,
      userRoot: f.userRoot,
      drainEvery: config.drainEvery,
      onProgress: (progress) => frame("generation-progress", progress),
    });
    profile?.mark("end", "generation");
    frame("generation", generated);
    const hotCatchUp = await hotFollower.finish(generated.headRevision, false, remainingMs());
    tier.generation = { ...generated, samples: undefined, hotCatchUp };
    frame("hot-catch-up", hotCatchUp);
    f.check("generation.exact-count-and-follower-verified", () => {
      assert.equal(generated.generatedEvents, config.targetEvents);
      assert.equal(generated.follower.git, "verified");
      assert.equal(generated.follower.worktree, "verified");
      assert.equal(generated.follower.cut, generated.headRevision);
      assert.equal(hotCatchUp.watermark, generated.headRevision);
    });
    frame("resources-after-generation", resourceSnapshot(f.parent, "after-generation"));

    // The daemon attaches to the current projection; its first write pays any whole-ledger follower work.
    const { samples } = generated;
    generatedSamples = samples;
    requireBudget("daemon attach and measurement", config.measureBudgetMs);
    f.invoke("attach.daemon-start", ["daemon", "start", "--service"], {
      timeoutMs: 600_000,
      extraEnv: profile?.daemonEnv,
    });
    f.invoke("attach.first-read", ["task", "list", "--limit", "1"], { timeoutMs: 600_000 });
    const firstWrite = guard("write.first-after-restart", () => importProbe("write.entity-import.first", 0));
    guard("write.first-publication", () => f.publish(firstWrite.receipt, "write.entity-import.first"));
    guard("write.entity-import", () => {
      for (let sample = 1; sample <= config.writeSamples; sample++) importProbe("write.entity-import", sample);
    });
    guard("write.decision-reckon", () => {
      for (let sample = 0; sample < config.writeSamples; sample++)
        f.invoke("write.decision-reckon", reckonArgs(sample), { frameRow: false });
    });
    // The resident arm writes other entities and reckons other decisions, so no write repeats one above.
    await guardAsync("write.in-process", async () => {
      for (let sample = 0; sample < config.writeSamples; sample++) {
        await inProcess("write.entity-import", probeInput(1_000 + sample).argv);
        await inProcess("write.decision-reckon", reckonArgs(config.writeSamples + sample));
      }
    });

    // Hot reads, both arms, one untimed warm-up each.
    const hub = `task/${samples.anchorTaskId}`,
      leaf = `task/${samples.taskIds.at(-1)}`,
      reads = [
        ["read.task-show", (sample) => ["task", "show", samples.taskIds[sample % samples.taskIds.length]]],
        ["read.task-list", () => ["task", "list"]],
        ["read.task-list.page", () => ["task", "list", "--limit", "50"]],
        ["read.relation-list.page", () => ["relation", "list", "--limit", "50"]],
        ["read.relation-list.hub", () => ["relation", "list", "--entity", hub, "--limit", "50"]],
        ["read.relation-list.leaf", () => ["relation", "list", "--entity", leaf, "--limit", "50"]],
        ["read.fact-search.selective", () => ["fact", "search", samples.factToken, "--limit", "20"]],
        ["read.fact-search.broad", () => ["fact", "search", "observation", "--limit", "20"]],
      ];
    for (const [metric, argv] of reads)
      guard(metric, () => {
        f.invoke(`${metric}.warm-up`, argv(0), { frameRow: false });
        for (let sample = 0; sample < config.readSamples; sample++) f.invoke(metric, argv(sample), { frameRow: false });
      });
    for (const [metric, argv] of reads)
      await guardAsync(`${metric}.in-process`, async () => {
        await inProcess(`${metric}.warm-up`, argv(0));
        for (let sample = 0; sample < config.readSamples; sample++) await inProcess(metric, argv(sample));
      });
    await profile?.stopProcess();

    // Content exactness and a concurrency negative control, at scale.
    guard("content.exact-bytes", () =>
      f.check("content.exact-bytes", () => {
        const root = `entities/research/${firstWrite.id}`;
        assertBytes(f.root, `${root}/README.md`, firstWrite.text, firstWrite.receipt, reader);
        assertBytes(f.root, `${root}/sample.bin`, firstWrite.binary, firstWrite.receipt, reader);
        assert.throws(() =>
          assertBytes(f.root, `${root}/sample.bin`, Buffer.from("dropped"), firstWrite.receipt, reader),
        );
      }),
    );
    guard("content.stale-update", () => {
      const current = f.invoke("probe.entity.get", ["entity", "get", kind, "--id", firstWrite.id]);
      const update = (title) => [
        ...["entity", "update", kind, "--id", firstWrite.id, "--title", title],
        ...["--expected-version", String(evidence(current).entity.workspaceRevision)],
      ];
      f.invoke("write.entity-update", update("Updated at scale"));
      const stale = f.invoke("write.entity-update.stale", update("Stale must fail"), { requireSuccess: false });
      f.check("content.stale-update-rejected", () => {
        assert.equal(stale.ok, false);
        assert.equal(stale.code, "revision_conflict");
      });
    });

    // One full Task document lifecycle through the real CLI against the scaled ledger.
    guard("task-lifecycle.at-scale", () => taskLifecycle(f, reader, "at-scale"));

    // Backup size and restore drill on the scaled ledger.
    const backupDir = path.join(f.parent, "scale-backup");
    const backup = guard("backup", () =>
      f.invoke("backup", ["backup", backupDir], { offline: true, timeoutMs: 600_000 }),
    );
    tier.backup = { bytes: directoryBytes(backupDir), files: backup?.manifest?.files?.length ?? null };
    guard("restore-drill", () => {
      const drill = f.invoke(
        "restore-drill",
        ["restore", "--drill", backupDir, "--shadow-parent", path.join(f.parent, "drills")],
        { offline: true, timeoutMs: 600_000 },
      );
      tier.restoreDrill = { shadowBytes: directoryBytes(drill.shadowRoot) };
      rmSync(path.join(f.parent, "drills"), { recursive: true, force: true });
    });
    rmSync(backupDir, { recursive: true, force: true });
    frame("backup", tier);

    // Strict rebuild: the daemon's hot projection must equal one built from empty, at the same cut.
    await f.stopDaemon("strict.daemon-stop");
    const finalRevision = reader.readHead().revision,
      cold = await coldFollower.finish(finalRevision, true, remainingMs()),
      hotStarted = performance.now(),
      hot = makeTaskProjection({ rootDir: f.root, eventStore: reader }),
      hotDigest = hot.readStateDigest(),
      hotCut = hot.readCut();
    hot.close();
    tier.strict = {
      finalRevision,
      cold,
      hot: { stateDigest: hotDigest, cut: hotCut, digestMs: performance.now() - hotStarted },
    };
    f.check("strict.hot-projection-equals-cold", () => {
      assert.equal(cold.watermark, finalRevision);
      assert.ok(hotDigest, "hot projection is at the source cut");
      assert.equal(hotDigest, cold.stateDigest);
    });
    // A sequential rebuild from empty with nothing else running, when the stage budget still allows it.
    const rebuildBudgetMs = remainingMs();
    if (rebuildBudgetMs > cold.busyMs * 1.5) {
      const rebuildStarted = performance.now(),
        rebuilt = makeTaskProjection({
          rootDir: f.root,
          eventStore: reader,
          projectionPath: path.join(f.parent, "cold-rebuild.sqlite"),
        }),
        receipt = rebuilt.rebuild();
      rebuilt.close();
      tier.rebuild = { ...receipt, elapsedMs: performance.now() - rebuildStarted };
      f.check("strict.sequential-rebuild-equals-hot", () => assert.equal(receipt.stateDigest, hotDigest));
    } else tier.rebuild = { skipped: "stage budget", remainingMs: rebuildBudgetMs, followerBusyMs: cold.busyMs };
    frame("strict", tier.strict);
    frame("rebuild", tier.rebuild);
    frame("resources-after", resourceSnapshot(f.parent, "after"));
  } catch (error) {
    failures.push({ phase: "run", error: error.message });
    frame("failure", failures.at(-1));
  } finally {
    frame("summary", {
      config,
      elapsedMs: elapsed(),
      tier,
      cliMetrics: summarize(f.rows, (row) => row.arm !== "in-process-reused-modules"),
      inProcessMetrics: summarize(f.rows, (row) => row.arm === "in-process-reused-modules"),
      samples: Object.fromEntries(
        [...new Set(f.rows.map(({ arm, metric }) => `${arm}|${metric}`))].map((key) => [
          key,
          f.rows.filter(({ arm, metric }) => `${arm}|${metric}` === key).map(({ wallMs }) => Math.round(wallMs)),
        ]),
      ),
      checks: f.checks,
      failures,
      verdict: failures.length ? "FAILURES_PRESENT" : "MEASURED",
    });
    await Promise.all([hotFollower?.stop(), coldFollower?.stop()]);
    await reader?.drain();
    await f.close();
  }
  assert.deepEqual(failures, [], "every measured failure is retained in the frames above");
});

function taskLifecycle(f, reader, label) {
  const taskId = `task-v2-scale-${label}`,
    actor = "agent:v2-scale-worker";
  const created = f.invoke(`task.create.${label}`, [
    "task",
    "create",
    "--id",
    taskId,
    "--admin",
    "--title",
    `V2 scale ${label}`,
    "--preset",
    "docs-task",
  ]);
  f.publish(created, `task.create.${label}`);
  const packagePath = created.packagePath,
    planPath = `${packagePath}/task_plan.md`;
  f.check(`task.${label}.initial-content`, () =>
    assertBytes(f.root, planPath, readFileSync(path.join(f.root, "harness", planPath)), created, reader),
  );
  writeFileSync(path.join(f.root, "harness", planPath), realizedTaskPlan(`V2 scale ${label}`));
  const prose = f.invoke(`task.prose.${label}`, ["doc", "sync", "--submit", "--path", planPath]);
  f.publish(prose, `task.prose.${label}`);
  f.invoke(`task.fact.${label}`, [
    "fact",
    "record",
    "--task",
    taskId,
    "--statement",
    `V2 scale ${label} plan bytes verified.`,
    "--source",
    "test:entity-v2-scale",
  ]);
  f.invoke(`task.start.${label}`, ["task", "start", taskId, "--execution-id", `execution-${label}`], { actor });
  const reportPath = `${packagePath}/artifacts/report.md`;
  const reportBody = Buffer.from(`# V2 scale ${label}\n\n${"durable bytes\n".repeat(32)}`);
  mkdirSync(path.dirname(path.join(f.root, "harness", reportPath)), { recursive: true });
  writeFileSync(path.join(f.root, "harness", reportPath), reportBody);
  writeFileSync(
    path.join(f.root, "harness", packagePath, "closeout.md"),
    "# Closeout\n\n## Summary\n\nReport delivered.\n\n## Verification\n\nExact bytes checked.\n\n" +
      "## Residual Risk\n\nBounded measurement.\n\n## Same Mechanism Elsewhere\n\nTask report ownership.\n",
  );
  const report = f.invoke(`task.report.${label}`, ["doc", "sync", "--submit", "--task", taskId], {
    actor,
  });
  f.publish(report, `task.report.${label}`, actor);
  f.check(`task.${label}.report-same-cut-bytes`, () => assertBytes(f.root, reportPath, reportBody, report, reader));
  const submission = {
    completionClaim: "Bounded scale report is complete.",
    deliverables: [reportPath],
    outputs: ["scale report"],
    verificationNotes: ["canonical blob, Git and worktree bytes checked"],
    knownGaps: [],
    residualRisks: [],
    commitSha: git(f.root, "rev-parse", "HEAD"),
  };
  writeFileSync(path.join(f.root, `submission-${label}.json`), JSON.stringify(submission));
  f.invoke(`task.submit.${label}`, ["task", "submit", taskId, "--from-file", `submission-${label}.json`], { actor });
  const closeout = f.invoke(`task.closeout.${label}`, ["task", "closeout", taskId, "--json-input", "@-"], {
    input: {
      review: { verdict: "approved", reason: "Fixture bytes checked.", evidenceChecked: [reportPath] },
      consent: { approved: true },
      completion: { ci: "not_applicable", codeDocPaths: [] },
    },
  });
  f.check(`task.${label}.real-stages`, () =>
    assert.deepEqual(
      closeout.steps.map(({ stage }) => stage),
      ["review-execution", "review-consent", "complete"],
    ),
  );
  const shown = f.invoke(`task.show.${label}`, ["task", "show", taskId]);
  f.check(`task.${label}.done`, () => assert.equal(evidence(shown).task.status, "done"));
}
