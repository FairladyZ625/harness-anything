// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../packages/kernel/src/index.ts";
import { main as cliMain } from "../../packages/cli/src/index.ts";
import { git } from "../../packages/cli/test/daemon-multi-repo-lifecycle-cli.fixtures.ts";
import { realizedTaskPlan } from "../fixtures/task-plan.mjs";
import {
  assertBytes,
  fixture,
  frame,
  readWorkloadConfig,
  resourceSnapshot,
  summarize,
  syntheticBinary,
} from "./entity-v2-scale.fixture.mjs";

const kind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
const config = readWorkloadConfig();
const evidence = (receipt) => JSON.parse(receipt.evidence);
const skip =
  process.platform !== "linux"
    ? "requires the isolated Linux measurement target"
    : config.enabled === true
      ? false
      : "workload disabled: tools/stress/entity-v2-scale.workload.json enabled=false";

test("bounded V2 scale: real CLI Task lifecycle and Entity content at a declared workset", { skip }, async () => {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const f = fixture(config.seed);
  const failures = [],
    capacity = {};
  let reader = null;
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
      // The node:test reporter writes its own binary protocol to these streams; only the CLI's
      // console.log receipt arrives as a string, so string chunks are the receipt channel and
      // everything else is passed straight through to the real stream.
      capture = (sink, passthrough) => (chunk, encoding, callback) => {
        if (typeof chunk !== "string") return passthrough(chunk, encoding, callback);
        sink.push(chunk);
        if (typeof encoding === "function") encoding();
        else if (typeof callback === "function") callback();
        return true;
      };
    process.stdout.write = capture(chunks, write);
    process.stderr.write = capture(errorChunks, writeError);
    const commandStarted = performance.now();
    let status = null,
      thrown = null;
    try {
      status = await cliMain(["--root", f.root, "--json", ...args]);
    } catch (error) {
      thrown = error;
    } finally {
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
    return row;
  };

  try {
    frame("protocol", {
      config,
      cache: "source CLI; no OS page cache eviction; cold reads are daemon-restart cold, not disk cold",
      interpretation:
        "arm cli-process includes Node startup and module load per operation; arm in-process-reused-modules does not. The two arms are never compared as a speedup.",
      resources: resourceSnapshot(f.parent, "before"),
    });

    f.invoke("setup.init", ["init", "--repo-id", config.repoId, "--person-id", "owner", "--display-name", "Owner"]);
    reader = makeTaskEventReader({ rootDir: f.root, repoId: config.repoId });

    // V2 entry: the production reader, the production writer receipts and a real backup must agree.
    const backupDir = path.join(f.parent, "entry-backup");
    const backup = f.invoke("v2.backup", ["backup", backupDir], { offline: true });
    f.check("v2.generation-two-before-workload", () => {
      assert.equal(reader.ledgerMetadata().generation, 2, "reader generation");
      assert.equal(backup.manifest?.sqlite?.generation, 2, JSON.stringify(backup.manifest));
    });
    frame("v2-entry", {
      readerGeneration: reader.ledgerMetadata().generation,
      backupManifest: backup.manifest,
      initialRevision: reader.readHead().revision,
    });

    // One full real Task document lifecycle on the empty repository.
    guard("task-lifecycle.empty", () => taskLifecycle(f, reader, "empty"));

    // Population to the declared workset, plus periodic exact-byte verification.
    const inputRoot = path.join(f.root, "inputs", "scale");
    mkdirSync(inputRoot, { recursive: true });
    const verified = [];
    const populateStarted = performance.now();
    let imported = 0,
      populationStop = "target-reached";
    for (let index = 0; index < config.targetEntities; index++) {
      if (performance.now() - populateStarted > config.populateBudgetMs) {
        populationStop = "populate-budget-exhausted";
        break;
      }
      const locator = `inputs/scale/${index}`,
        directory = path.join(f.root, locator);
      mkdirSync(directory, { recursive: true });
      const text = Buffer.from(`# Scale ${config.seed}/${index}\n${"canonical content\n".repeat(8)}`),
        binary = syntheticBinary(config.seed + index, config.binaryBytes);
      writeFileSync(path.join(directory, "README.md"), text);
      writeFileSync(path.join(directory, "sample.bin"), binary);
      const row = await inProcess("entity.import.populate", [
        "entity",
        "import",
        "--kind",
        kind,
        "--locator",
        locator,
        "--expected-version",
        "0",
        "--no-wait",
      ]);
      if (!row.ok) {
        failures.push({
          phase: `populate-${index}`,
          error: JSON.stringify({ exit: row.exit, thrown: row.error, stdout: row.stdout, stderr: row.stderr }).slice(
            0,
            2000,
          ),
        });
        frame("failure", failures.at(-1));
        populationStop = "import-rejected";
        break;
      }
      imported += 1;
      if (
        verified.length < config.contentSamples &&
        index % Math.max(1, Math.floor(config.targetEntities / config.contentSamples)) === 0
      ) {
        verified.push({ index, id: evidence(row.receipt).preview.entityId, receipt: row.receipt, text, binary });
      }
      if (index % 100 === 0)
        frame("populate-progress", {
          index,
          imported,
          elapsedMs: elapsed(),
          populateMs: performance.now() - populateStarted,
        });
    }
    const populateMs = performance.now() - populateStarted;
    capacity.population = {
      requested: config.targetEntities,
      imported,
      stop: populationStop,
      populateMs,
      opsPerSecond: imported / (populateMs / 1000),
      arm: "in-process-reused-modules",
    };
    frame("capacity", capacity.population);

    const afterPopulation = reader.readHead().revision;
    frame("cut-after-population", { revision: afterPopulation, entities: imported });

    // Exact-byte oracle on the sampled entities, plus the negative control that proves the oracle bites.
    for (const sample of verified) {
      const contentRoot = `entities/research/${sample.id}`;
      guard(`content.bytes-${sample.index}`, () =>
        f.check(`content.exact-bytes-${sample.index}`, () => {
          assertBytes(f.root, `${contentRoot}/README.md`, sample.text, sample.receipt, reader);
          assertBytes(f.root, `${contentRoot}/sample.bin`, sample.binary, sample.receipt, reader);
        }),
      );
    }
    if (verified.length > 0)
      guard("content.negative-control", () =>
        f.check("content.oracle-rejects-wrong-bytes", () =>
          assert.throws(() =>
            assertBytes(
              f.root,
              `entities/research/${verified[0].id}/sample.bin`,
              Buffer.from("dropped bytes"),
              verified[0].receipt,
              reader,
            ),
          ),
        ),
      );

    // Latency probes at the populated scale, full CLI chain.
    guard("probe.cli-import", () => {
      for (let sample = 0; sample < config.cliProbeSamples; sample++) {
        const locator = `inputs/probe/${sample}`,
          directory = path.join(f.root, locator);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "README.md"), Buffer.from(`# Probe ${sample}\n`));
        writeFileSync(path.join(directory, "sample.bin"), syntheticBinary(90_000 + sample, config.binaryBytes));
        f.invoke(
          "probe.entity.import",
          ["entity", "import", "--kind", kind, "--locator", locator, "--expected-version", "0", "--no-wait"],
          { frameRow: false },
        );
      }
    });
    const probeReceipt = f.rows.findLast((row) => row.metric === "probe.entity.import")?.receipt;
    const probeId = probeReceipt ? evidence(probeReceipt).preview.entityId : null;
    guard("probe.publication", () => f.publish(probeReceipt, "probe.entity.import"));

    guard("probe.cli-get-warm", () => {
      for (let sample = 0; sample < config.cliProbeSamples; sample++)
        f.invoke("probe.entity.get.warm", ["entity", "get", kind, "--id", probeId], { frameRow: false });
    });
    guard("probe.cli-list-warm", () =>
      f.invoke("probe.entity.list.warm", ["entity", "list", kind], { frameRow: false }),
    );

    // Update and its concurrency negative control at scale.
    guard("probe.update", () => {
      const current = f.invoke("probe.entity.get.before-update", ["entity", "get", kind, "--id", probeId], {
        frameRow: false,
      });
      const updated = f.invoke("probe.entity.update", [
        "entity",
        "update",
        kind,
        "--id",
        probeId,
        "--title",
        "Updated at scale",
        "--expected-version",
        String(current.revision),
        "--no-wait",
      ]);
      f.publish(updated, "probe.entity.update");
      const warm = f.invoke("probe.entity.get.after-update", ["entity", "get", kind, "--id", probeId]);
      f.check("probe.updated-title-visible", () => assert.equal(evidence(warm).entity.value.title, "Updated at scale"));
      const stale = f.invoke(
        "probe.entity.update.stale-negative",
        [
          "entity",
          "update",
          kind,
          "--id",
          probeId,
          "--title",
          "Stale must fail",
          "--expected-version",
          String(current.revision),
        ],
        { requireSuccess: false },
      );
      f.check("probe.stale-update-rejected", () => {
        assert.equal(stale.ok, false);
        assert.equal(stale.code, "revision_conflict");
      });
    });

    // Concurrent clients, each an independent CLI process against the one daemon.
    await guardAsync("probe.concurrent-reads", async () => {
      const rounds = config.concurrentRounds ?? 1,
        batches = [];
      let succeeded = 0;
      for (let round = 0; round < rounds; round++) {
        const { batchMs, results } = await f.concurrentCli(
          "probe.entity.get.concurrent",
          Array.from({ length: config.clients }, () => ["entity", "get", kind, "--id", probeId]),
        );
        batches.push(batchMs);
        succeeded += results.filter((row) => row.exit === 0 && row.receipt?.ok).length;
      }
      capacity.concurrentReads = {
        clients: config.clients,
        rounds,
        batchMs: batches,
        succeeded,
        readsPerSecond: succeeded / (batches.reduce((sum, value) => sum + value, 0) / 1000),
      };
      frame("capacity", { concurrentReads: capacity.concurrentReads });
    });
    await guardAsync("probe.concurrent-writes", async () => {
      const rounds = config.concurrentRounds ?? 1,
        batches = [],
        opIds = new Set(),
        rejections = [];
      let accepted = 0;
      for (let round = 0; round < rounds; round++) {
        for (let client = 0; client < config.clients; client++) {
          const directory = path.join(f.root, "inputs", "concurrent", `${round}-${client}`);
          mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, "README.md"), Buffer.from(`# Concurrent ${round}/${client}\n`));
          writeFileSync(
            path.join(directory, "sample.bin"),
            syntheticBinary(70_000 + round * 100 + client, config.binaryBytes),
          );
        }
        const { batchMs, results } = await f.concurrentCli(
          "probe.entity.import.concurrent",
          Array.from({ length: config.clients }, (_unused, client) => [
            "entity",
            "import",
            "--kind",
            kind,
            "--locator",
            `inputs/concurrent/${round}-${client}`,
            "--expected-version",
            "0",
            "--no-wait",
          ]),
        );
        batches.push(batchMs);
        for (const row of results) {
          if (row.exit === 0 && row.receipt?.ok) {
            accepted += 1;
            opIds.add(row.receipt.opId);
          } else if (row.receipt?.ok === false) rejections.push(row.receipt.code);
        }
      }
      capacity.concurrentWrites = {
        clients: config.clients,
        rounds,
        batchMs: batches,
        accepted,
        distinctOpIds: opIds.size,
        rejections,
        writesPerSecond: accepted / (batches.reduce((sum, value) => sum + value, 0) / 1000),
      };
      frame("capacity", { concurrentWrites: capacity.concurrentWrites });
    });

    // Cold read: stop the daemon, then time the first read that has to reopen the ledger.
    guard("probe.cold-read", () => {
      f.invoke("cold.daemon-stop", ["daemon", "stop"], { requireSuccess: false });
      f.invoke("cold.daemon-start", ["daemon", "start", "--service"], { timeoutMs: 120_000 });
      f.invoke("cold.entity.list", ["entity", "list", kind], { timeoutMs: 300_000 });
      f.invoke("cold.entity.get", ["entity", "get", kind, "--id", probeId]);
      for (let sample = 0; sample < config.cliProbeSamples; sample++)
        f.invoke("hot.entity.list", ["entity", "list", kind], { frameRow: false });
    });

    // Large content, bounded by the remaining budget.
    guard("probe.large-content", () => {
      const locator = "inputs/large/0",
        directory = path.join(f.root, locator),
        large = syntheticBinary(4242, config.largeBytes);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "large.bin"), large);
      const receipt = f.invoke("probe.entity.import.large", [
        "entity",
        "import",
        "--kind",
        kind,
        "--locator",
        locator,
        "--expected-version",
        "0",
        "--no-wait",
      ]);
      const id = evidence(receipt).preview.entityId;
      f.publish(receipt, "probe.entity.import.large");
      f.check("large.exact-bytes", () =>
        assertBytes(f.root, `entities/research/${id}/large.bin`, large, receipt, reader),
      );
      capacity.largeContent = { bytes: config.largeBytes, id };
    });

    // Recovery: delete materialized content and rebuild it from the canonical ledger.
    guard("probe.recovery", () => {
      const sample = verified[0];
      assert.ok(sample, "recovery needs at least one byte-verified sample");
      const contentRoot = `entities/research/${sample.id}`,
        before = reader.readHead().revision;
      rmSync(path.join(f.root, "harness", contentRoot), { recursive: true });
      f.invoke("recovery.materialize", ["doc", "materialize"], { timeoutMs: 600_000 });
      f.check("recovery.no-new-events-and-exact-bytes", () => {
        assert.equal(reader.readHead().revision, before);
        assert.deepEqual(readFileSync(path.join(f.root, "harness", contentRoot, "README.md")), sample.text);
        assert.deepEqual(readFileSync(path.join(f.root, "harness", contentRoot, "sample.bin")), sample.binary);
      });
      capacity.recovery = { revision: before, restored: contentRoot };
    });

    // A second full Task lifecycle, now against the populated ledger.
    guard("task-lifecycle.at-scale", () => taskLifecycle(f, reader, "at-scale"));

    const finalBackupDir = path.join(f.parent, "final-backup");
    const finalBackup = guard("v2.final-backup", () =>
      f.invoke("v2.backup.final", ["backup", finalBackupDir], { offline: true }),
    );
    frame("v2-exit", {
      readerGeneration: reader.ledgerMetadata().generation,
      backupManifest: finalBackup?.manifest ?? null,
      finalRevision: reader.readHead().revision,
    });
    frame("resources-after", resourceSnapshot(f.parent, "after"));
  } catch (error) {
    failures.push({ phase: "run", error: error.message });
    frame("failure", failures.at(-1));
  } finally {
    frame("summary", {
      config,
      elapsedMs: elapsed(),
      capacity,
      cliMetrics: summarize(f.rows, (row) => row.arm !== "in-process-reused-modules"),
      inProcessMetrics: summarize(f.rows, (row) => row.arm === "in-process-reused-modules"),
      checks: f.checks,
      failures,
      verdict: failures.length ? "FAILURES_PRESENT" : "MEASURED",
    });
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
    "--no-wait",
  ]);
  f.publish(created, `task.create.${label}`);
  const packagePath = created.packagePath,
    planPath = `${packagePath}/task_plan.md`;
  f.check(`task.${label}.initial-content`, () =>
    assertBytes(f.root, planPath, readFileSync(path.join(f.root, "harness", planPath)), created, reader),
  );
  writeFileSync(path.join(f.root, "harness", planPath), realizedTaskPlan(`V2 scale ${label}`));
  const prose = f.invoke(`task.prose.${label}`, ["doc", "sync", "--submit", "--path", planPath, "--no-wait"]);
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
  f.invoke(`doc.status.${label}`, ["doc", "status", "--task", taskId], { actor });
  const report = f.invoke(`task.report.${label}`, ["doc", "sync", "--submit", "--task", taskId, "--no-wait"], {
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
