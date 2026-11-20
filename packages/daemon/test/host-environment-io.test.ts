// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHostScratchDirectory,
  hostEnvironmentFilePath,
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
