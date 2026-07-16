// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  acquireLocalHeavySlot,
  DEFAULT_LOCAL_SLOTS,
  discoverQosPrefix,
  LOCAL_SLOT_ROOT,
  processStartFingerprint,
  prefixCommand,
  resolveLocalSlotCount,
  selectQosPrefix
} from "./local-resource-governance.mjs";

test("local slot capacity defaults to three and rejects invalid overrides", () => {
  assert.equal(DEFAULT_LOCAL_SLOTS, 3);
  assert.equal(LOCAL_SLOT_ROOT, path.join(homedir(), ".harness", "locks", "local-heavy-v1"));
  assert.equal(resolveLocalSlotCount(undefined), 3);
  assert.equal(resolveLocalSlotCount("2"), 2);
  assert.throws(() => resolveLocalSlotCount("0"), /positive integer/u);
  assert.throws(() => resolveLocalSlotCount("many"), /positive integer/u);
});

test("process fingerprints use ps lstart and fail conservatively when unavailable", () => {
  const calls = [];
  const fingerprint = processStartFingerprint(42, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "Tue Jul 14 12:00:00 2026\n" };
  });
  assert.equal(fingerprint, "Tue Jul 14 12:00:00 2026");
  assert.equal(calls[0].command, "ps");
  assert.deepEqual(calls[0].args, ["-o", "lstart=", "-p", "42"]);
  assert.equal(processStartFingerprint(42, () => ({ status: 1, stdout: "" })), null);
});

test("QoS selection prefers taskpolicy on darwin and otherwise falls back to nice", () => {
  assert.deepEqual(selectQosPrefix({ platform: "darwin", hasTaskpolicy: true, hasNice: true }), ["taskpolicy", "-c", "utility"]);
  assert.deepEqual(selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: true }), ["nice", "-n", "10"]);
  assert.deepEqual(selectQosPrefix({ platform: "darwin", hasTaskpolicy: false, hasNice: false }), []);
  assert.deepEqual(discoverQosPrefix({ platform: "darwin", commandExists: (name) => name === "taskpolicy", isCi: false }), ["taskpolicy", "-c", "utility"]);
  assert.deepEqual(discoverQosPrefix({ platform: "darwin", commandExists: () => true, isCi: true }), []);
  assert.deepEqual(discoverQosPrefix({
    platform: "win32",
    commandExists: () => { throw new Error("Windows must not probe POSIX commands"); },
    isCi: false
  }), []);
  assert.deepEqual(prefixCommand(["nice", "-n", "10"], "node", ["test.mjs"]), {
    command: "nice",
    args: ["-n", "10", "node", "test.mjs"]
  });
});

test("an inherited token reuses one slot and cannot release its owner", async (context) => {
  const root = temporaryRoot(context);
  const outer = await acquireLocalHeavySlot({ root, slots: 1, label: "outer" });
  const inner = await acquireLocalHeavySlot({ root, slots: 1, label: "inner", env: outer.childEnv });

  assert.equal(inner.inherited, true);
  assert.equal(inner.slotPath, outer.slotPath);
  assert.deepEqual(readdirSync(root), ["slot-0"]);
  inner.release();
  assert.deepEqual(readdirSync(root), ["slot-0"]);
  outer.release();
  assert.deepEqual(readdirSync(root), []);
});

test("a child process inherits its outer lease without acquiring a second slot", async (context) => {
  const root = temporaryRoot(context);
  const outer = await acquireLocalHeavySlot({ root, slots: 1, label: "outer-process" });
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "local-resource-governance.mjs")).href;
  const source = [
    `import { acquireLocalHeavySlot } from ${JSON.stringify(moduleUrl)};`,
    `const lease = await acquireLocalHeavySlot({ root: ${JSON.stringify(root)}, slots: 1, label: "inner-process" });`,
    "console.log(JSON.stringify({ inherited: lease.inherited, slotPath: lease.slotPath }));",
    "lease.release();"
  ].join("\n");
  const result = await runChild(source, outer.childEnv);
  assert.deepEqual(JSON.parse(result), { inherited: true, slotPath: outer.slotPath });
  assert.deepEqual(readdirSync(root), ["slot-0"]);
  outer.release();
});

test("a stale PID is reaped while a live PID with unavailable ps remains occupied", async (context) => {
  const root = temporaryRoot(context);
  const staleSlot = path.join(root, "slot-0");
  mkdirSync(staleSlot, { recursive: true });
  writeOwner(staleSlot, { token: "dead", pid: 919191, processStart: "old" });
  const recovered = await acquireLocalHeavySlot({
    root,
    slots: 1,
    label: "recovered",
    hostname: "test-host",
    processAlive: () => false,
    processFingerprint: () => null,
    pollMs: 1
  });
  assert.notEqual(recovered.token, "dead");
  recovered.release();

  const liveSlot = path.join(root, "slot-0");
  mkdirSync(liveSlot);
  writeOwner(liveSlot, { token: "live", pid: process.pid, processStart: "known" });
  let slept = false;
  await assert.rejects(
    acquireLocalHeavySlot({
      root,
      slots: 1,
      label: "blocked",
      hostname: "test-host",
      processAlive: () => true,
      processFingerprint: () => null,
      pollMs: 1,
      sleep: async () => {
        slept = true;
        throw new Error("still occupied");
      }
    }),
    /still occupied/u
  );
  assert.equal(slept, true);
});

test("a reused PID fingerprint and an old incomplete owner are reclaimed", async (context) => {
  const root = temporaryRoot(context);
  const reusedSlot = path.join(root, "slot-0");
  mkdirSync(reusedSlot, { recursive: true });
  writeOwner(reusedSlot, { token: "reused", pid: process.pid, processStart: "old-start" });
  const reused = await acquireLocalHeavySlot({
    root,
    slots: 1,
    hostname: "test-host",
    processAlive: () => true,
    processFingerprint: () => "new-start",
    label: "pid-reuse"
  });
  assert.notEqual(reused.token, "reused");
  reused.release();

  const incompleteSlot = path.join(root, "slot-0");
  mkdirSync(incompleteSlot);
  const incomplete = await acquireLocalHeavySlot({
    root,
    slots: 1,
    hostname: "test-host",
    now: () => Date.now() + 60_000,
    initializationGraceMs: 1,
    label: "incomplete-owner"
  });
  assert.equal(incomplete.slotPath, incompleteSlot);
  incomplete.release();
});

test("four independent processes obey a three-slot machine-wide bound", async (context) => {
  const root = temporaryRoot(context);
  const workers = ["one", "two", "three"].map((id) => startWorker(root, id));
  context.after(() => workers.forEach(stopWorker));

  assert.equal(await workers[0].entered, "entered:one");
  assert.equal(await workers[1].entered, "entered:two");
  assert.equal(await workers[2].entered, "entered:three");
  workers.push(startWorker(root, "four"));
  const fourthEarly = await Promise.race([workers[3].entered.then(() => true), delay(350).then(() => false)]);
  assert.equal(fourthEarly, false, "the fourth process must remain queued while three slots are held");

  workers[0].child.stdin.end("release\n");
  assert.equal(await workers[3].entered, "entered:four");
});

function temporaryRoot(context) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-local-qos-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeOwner(slotPath, overrides) {
  writeFileSync(path.join(slotPath, "owner.json"), `${JSON.stringify({
    schema: "harness-local-heavy-owner/v1",
    hostname: "test-host",
    acquiredAt: new Date().toISOString(),
    label: "fixture",
    ...overrides
  })}\n`);
}

function startWorker(root, id) {
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "local-resource-governance.mjs")).href;
  const source = [
    `import { acquireLocalHeavySlot } from ${JSON.stringify(moduleUrl)};`,
    `const lease = await acquireLocalHeavySlot({ root: ${JSON.stringify(root)}, slots: 3, label: ${JSON.stringify(id)}, pollMs: 20 });`,
    `console.log(${JSON.stringify(`entered:${id}`)});`,
    "process.stdin.resume();",
    "process.stdin.once('data', () => { lease.release(); process.exit(0); });"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const entered = new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(chunk.toString().trim()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`worker ${id} exited ${code}: ${stderr}`));
    });
  });
  return { child, entered };
}

function stopWorker(worker) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.stdin.end("release\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runChild(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}
