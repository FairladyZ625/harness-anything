// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAuditChainAccumulator,
  verifyAuditSliceContent,
} from "@harness-anything/kernel/internal/integrity/audit-hash-chain.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import {
  createHostScratchDirectory,
  hostEnvironmentFilePath,
  openCallerOutputLineWriter,
  writeHostEnvironmentFile,
} from "../src/daemon-host/host-environment-io.ts";

test("concurrent checkpoint publication leaves complete JSON and no staging files", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ha-host-checkpoints-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const kind = "fleetSnapshotTransfer",
    records = Array.from({ length: 32 }, (_, index) => JSON.stringify({ index, body: String(index).repeat(8192) }));
  await writeHostEnvironmentFile(kind, directory, records[0]!);
  const [, observed] = await Promise.all([
    Promise.all(records.map((record) => writeHostEnvironmentFile(kind, directory, record))),
    Promise.all(records.map(() => readFile(hostEnvironmentFilePath(kind, directory), "utf8"))),
  ]);
  for (const record of observed) assert.ok(records.includes(record));
  assert.ok(records.includes(await readFile(hostEnvironmentFilePath(kind, directory), "utf8")));
  assert.deepEqual(await readdir(directory), ["transfer.json"]);
});

test("a failed checkpoint rename cleans its temporary file and preserves the destination", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ha-host-checkpoints-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = hostEnvironmentFilePath("fleetSnapshotPin", directory);
  await mkdir(target);
  await writeFile(path.join(target, "witness"), "still here");
  await assert.rejects(writeHostEnvironmentFile("fleetSnapshotPin", directory, "{}"));
  assert.deepEqual(await readdir(directory), ["pin.json"]);
  assert.equal(await readFile(path.join(target, "witness"), "utf8"), "still here");
});

test("scratch handles own separate directories and close only once", async (t) => {
  const first = createHostScratchDirectory("migrationOracle"),
    second = createHostScratchDirectory("migrationOracle");
  t.after(() => rm(first.directory, { recursive: true, force: true }));
  t.after(second.close);
  assert.notEqual(first.directory, second.directory);
  first.close();
  await assert.rejects(readdir(first.directory), { code: "ENOENT" });
  assert.deepEqual(await readdir(second.directory), []);
  await mkdir(first.directory);
  first.close();
  assert.deepEqual(await readdir(first.directory), []);
});

test("staged caller output writer preserves verifiable prior export on final switch failure and switches atomically on commit", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ha-caller-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = lifecycleFixture({ taskId: "task_dm07_001", executionId: "exec_dm07_001", reviewId: "rev_dm07_001" });
  const manifestPath = path.join(directory, "audit-manifest.json");
  const anchorPath = path.join(directory, "audit-events.jsonl");

  // Publish verifiable v1 export
  const acc1 = createAuditChainAccumulator({
    repoId: "repo-dm07",
    algorithm: "sha256",
    window: { fromRevision: 1, toRevision: 3, utcDate: null, after: null, before: null },
  });
  const lines1 = fixture.events.slice(0, 3).map((e) => acc1.addEvent(e).line);
  const manifest1 = acc1.finalize();
  const entries1Path = path.join(directory, manifest1.entriesFile);
  const writer1 = await openCallerOutputLineWriter(anchorPath);
  for (const line of lines1) await writer1.writeLine(line);
  await writer1.commit({
    filePath: manifestPath,
    contents: `${JSON.stringify(manifest1, null, 2)}\n`,
    entriesTargetPath: entries1Path,
  });
  assert.deepEqual((await readdir(directory)).sort(), [manifest1.entriesFile, "audit-manifest.json"].sort());

  // Abort mid-stream preserves v1 cleanly
  const aborted = await openCallerOutputLineWriter(anchorPath);
  await aborted.writeLine("partial-new\n");
  await aborted.abort();
  assert.deepEqual((await readdir(directory)).sort(), [manifest1.entriesFile, "audit-manifest.json"].sort());

  // DM-07: Injected failure right before final manifest switch MUST leave v1 100% intact & verifiable!
  const acc2 = createAuditChainAccumulator({
    repoId: "repo-dm07",
    algorithm: "sha256",
    window: { fromRevision: 1, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const lines2 = fixture.events.map((e) => acc2.addEvent(e).line);
  const manifest2 = acc2.finalize();
  assert.notEqual(manifest2.entriesFile, manifest1.entriesFile);
  const entries2Path = path.join(directory, manifest2.entriesFile);

  const failingWriter = await openCallerOutputLineWriter(anchorPath);
  for (const line of lines2) await failingWriter.writeLine(line);
  await assert.rejects(
    failingWriter.commit({
      filePath: manifestPath,
      contents: `${JSON.stringify(manifest2, null, 2)}\n`,
      entriesTargetPath: entries2Path,
      beforeSwitch: () => {
        throw new Error("simulated crash before final manifest switch");
      },
    }),
    /simulated crash before final manifest switch/u,
  );
  await failingWriter.close();
  assert.deepEqual((await readdir(directory)).sort(), [manifest1.entriesFile, "audit-manifest.json"].sort());
  const stillV1Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const stillV1Entries = await readFile(path.join(directory, stillV1Manifest.entriesFile), "utf8");
  const verifyStillV1 = verifyAuditSliceContent({
    manifest: stillV1Manifest,
    entriesContent: stillV1Entries,
    expectedRootHash: manifest1.rootHash,
  });
  assert.equal(verifyStillV1.ok, true, JSON.stringify(verifyStillV1));

  // DM-07: Identical re-export crashing before switch MUST NOT delete the pre-existing content-addressed entries file!
  const failingSameTarget = await openCallerOutputLineWriter(anchorPath);
  for (const line of lines1) await failingSameTarget.writeLine(line);
  await assert.rejects(
    failingSameTarget.commit({
      filePath: manifestPath,
      contents: `${JSON.stringify(manifest1, null, 2)}\n`,
      entriesTargetPath: entries1Path,
      beforeSwitch: () => {
        throw new Error("simulated crash on identical re-export");
      },
    }),
    /simulated crash on identical re-export/u,
  );
  await failingSameTarget.close();
  assert.equal(await readFile(entries1Path, "utf8"), lines1.join(""));

  // DM-07: Concurrent reader reads v1 manifest before v2 switch; v2 switches manifest atomically while RETAINING
  // immutable v1 entries file so concurrent reader never hits ENOENT!
  const concurrentReaderManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const committed = await openCallerOutputLineWriter(anchorPath);
  for (const line of lines2) await committed.writeLine(line);
  await committed.commit({
    filePath: manifestPath,
    contents: `${JSON.stringify(manifest2, null, 2)}\n`,
    entriesTargetPath: entries2Path,
  });
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [manifest1.entriesFile, manifest2.entriesFile, "audit-manifest.json"].sort(),
  );
  // Concurrent v1 reader opens entries1 AFTER v2 switch -> still succeeds!
  const concurrentV1Entries = await readFile(path.join(directory, concurrentReaderManifest.entriesFile), "utf8");
  const verifyConcurrentV1 = verifyAuditSliceContent({
    manifest: concurrentReaderManifest,
    entriesContent: concurrentV1Entries,
    expectedRootHash: manifest1.rootHash,
  });
  assert.equal(verifyConcurrentV1.ok, true, JSON.stringify(verifyConcurrentV1));
  const nowV2Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const nowV2Entries = await readFile(path.join(directory, nowV2Manifest.entriesFile), "utf8");
  const verifyV2 = verifyAuditSliceContent({
    manifest: nowV2Manifest,
    entriesContent: nowV2Entries,
    expectedRootHash: manifest2.rootHash,
  });
  assert.equal(verifyV2.ok, true, JSON.stringify(verifyV2));
});
