// harness-test-tier: integration
import { waitForArrival, watchDirectoryArrival } from "../../../tools/fixtures/event-arrival.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { waitForArrival } from "../../../tools/fixtures/event-arrival.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { daemonServiceUnit } from "../src/client/daemon-service.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { acquireDaemonSingleton, readDaemonPid, readDaemonSingletonLockPid } from "../src/daemon-singleton.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

function killIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

for (const { failDrain, supervised, fakeService, failSuccessor, failDeadline = false } of [
  { failDrain: true, supervised: true, fakeService: false, failSuccessor: false },
  { failDrain: false, supervised: true, fakeService: false, failSuccessor: false },
  { failDrain: true, supervised: false, fakeService: false, failSuccessor: false },
  { failDrain: true, supervised: false, fakeService: true, failSuccessor: false },
  { failDrain: false, supervised: false, fakeService: false, failSuccessor: true },
  { failDrain: false, supervised: false, fakeService: false, failSuccessor: false, failDeadline: true },
  { failDrain: false, supervised: false, fakeService: true, failSuccessor: false, failDeadline: true },
  { failDrain: false, supervised: true, fakeService: false, failSuccessor: false, failDeadline: true },
]) {
  test(
    `${fakeService ? "installed-service" : supervised ? "supervised" : "on-demand"} resident ${failDeadline ? "shutdown deadline" : failSuccessor ? "failed successor callback" : failDrain ? "failed drain" : "handoff"} preserves and re-adopts a runtime calling the CLI`,
    { skip: process.platform === "win32" ? "requires POSIX detached process groups" : false, timeout: 90_000 },
    async () => {
      const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-readopt-")),
        buildRoot = mkdtempSync(path.join(path.resolve("packages/daemon"), ".resident-readopt-")),
        dist = path.join(buildRoot, "dist"),
        rootDir = path.join(parent, "repo"),
        userRoot = path.join(parent, "user"),
        marker = path.join(dist, "build-id.txt"),
        entry = path.join(dist, "daemon/src/bin.js"),
        runtime = path.join(dist, "daemon/src/runtime.js"),
        repoId = "resident-readopt",
        sessionFile = path.join(parent, "session.json"),
        failureEntered = path.join(parent, "failure-entered"),
        failureRelease = path.join(parent, "failure-release"),
        managerSeen = path.join(parent, "manager-seen"),
        release = path.join(parent, "release"),
        cliBefore = path.join(parent, "cli-before"),
        cliAfter = path.join(parent, "cli-after"),
        providerPid = path.join(parent, "provider.pid"),
        buildWitness = path.join(parent, "disk-build.pid"),
        endpoint = localUserDaemonEndpoint(userRoot, repoId),
        provider = writeProviderExecutable(
          path.join(parent, "provider.mjs"),
          `
import fs from "node:fs"; import { execFile } from "node:child_process";
fs.readFileSync(0, "utf8"); fs.writeFileSync(${JSON.stringify(providerPid)}, String(process.pid));
console.log(JSON.stringify({type:"thread.started",thread_id:"resident-readopt"}));
const env = {...process.env}; for (const k of ["HARNESS_ACTOR","HARNESS_EXECUTION_CREDENTIAL","HARNESS_DAEMON_ENDPOINT","HARNESS_DAEMON_RELAY","NODE_OPTIONS"]) delete env[k];
function probe() { if (fs.existsSync(${JSON.stringify(release)})) return; execFile(process.execPath, [${JSON.stringify(path.resolve("packages/cli/src/index.ts"))}, "--root", ${JSON.stringify(rootDir)}, "--json", "daemon", "status", "--user-root", ${JSON.stringify(userRoot)}, "--daemon-id", ${JSON.stringify(repoId)}], {env}, (err, out) => { if (!err) { const target = out.includes('"loadedBuildId":"build-b"') ? ${JSON.stringify(cliAfter)} : ${JSON.stringify(cliBefore)}; if (!fs.existsSync(target)) { fs.writeFileSync(target + ".tmp", String(Date.now())); fs.renameSync(target + ".tmp", target); } } setImmediate(probe); }); }
probe(); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); console.log(JSON.stringify({type:"item.completed",item:{id:"message",type:"agent_message",text:"survived"}})); console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})); }, 10);
`,
        );
      const until = (predicate: () => boolean | Promise<boolean>, _message: string): Promise<void> =>
        waitForArrival(async () => ((await predicate()) ? true : null), watchDirectoryArrival(parent));
      mkdirSync(rootDir, { recursive: true });
      for (const args of [
        ["init", "--quiet"],
        ["config", "user.name", "Resident Test"],
        ["config", "user.email", "resident@example.invalid"],
        ["config", "gc.auto", "0"],
        ["commit", "--allow-empty", "--quiet", "-m", "fixture"],
      ])
        execFileSync("git", ["-C", rootDir, ...args]);
      mkdirSync(path.join(rootDir, "harness"));
      writeFileSync(
        path.join(rootDir, "harness/harness.yaml"),
        `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
      );
      execFileSync("git", ["-C", rootDir, "add", "harness"]);
      execFileSync("git", ["-C", rootDir, "commit", "--quiet", "-m", "settings"]);
      registerBootstrappedDaemonRepo({
        canonicalRoot: rootDir,
        repoId,
        userRoot,
        createConvenienceLinks: false,
        runtimeInstances: [{ instanceId: "codex-resident-readopt", enabled: true }],
      });
      cpSync(path.resolve("packages/daemon/dist"), dist, { recursive: true });
      writeFileSync(marker, "build-a\n");
      const source = readFileSync(runtime, "utf8"),
        hooked = source.replace(
          /openDaemonHost\(\{\s*\.\.\.input,/,
          (match) => `${match}\n        openCell: globalThis.residentTestOpenCell,`,
        );
      assert.notEqual(hooked, source, "fixture must inject its repo cell into the actual resident runtime");
      const injectedRuntime = failSuccessor
        ? hooked.replace("await input.onSupersededExit?.();", "throw new Error('injected successor callback failure');")
        : hooked;
      if (failSuccessor) assert.notEqual(injectedRuntime, hooked, "fixture must inject the successor failure");
      const deadlineRuntime = failDeadline
        ? injectedRuntime.replace(
            "input.shutdownDeadlineMs ?? 30_000",
            'buildObserver.status().loadedBuildId === "build-a" ? 100 : 30_000',
          )
        : injectedRuntime;
      if (failDeadline)
        assert.notEqual(deadlineRuntime, injectedRuntime, "fixture must shorten the real shutdown deadline");
      writeFileSync(runtime, deadlineRuntime);
      if (!supervised && !failSuccessor) {
        const binSource = readFileSync(entry, "utf8"),
          heldBin = binSource.replace(
            "const output = openDaemonOutputFd(",
            "await globalThis.residentFailureGate();\n    const output = openDaemonOutputFd(",
          );
        assert.notEqual(heldBin, binSource, "fixture must hold the failed-drain recovery before spawning a successor");
        writeFileSync(entry, heldBin);
      }
      const config = path.join(parent, "fixture.json");
      writeFileSync(
        config,
        JSON.stringify({
          userRoot,
          repoId,
          provider,
          sessionFile,
          marker,
          failDrain,
          failDeadline,
          failureEntered,
          failureRelease,
          failBeforeCellClose: !supervised,
        }),
      );
      if (fakeService) {
        const unit = daemonServiceUnit({ userRoot, daemonId: repoId }, process.platform, parent)!;
        mkdirSync(path.dirname(unit.unitPath), { recursive: true });
        writeFileSync(unit.unitPath, "isolated test unit\n");
        const manager = path.join(parent, unit.manager === "launchd" ? "launchctl" : "systemctl");
        writeFileSync(
          manager,
          `#!${process.execPath}\nconst fs = require("node:fs"), {spawn} = require("node:child_process"); fs.writeFileSync(${JSON.stringify(managerSeen)}, "started"); const child = spawn(process.execPath, ${JSON.stringify([entry, "--service", "--supervised", "--user-root", userRoot, "--daemon-id", repoId])}, {env:process.env, detached:true, stdio:"ignore"}); child.unref();\n`,
        );
        chmodSync(manager, 0o755);
      }
      const env = {
        ...process.env,
        ...(fakeService ? { PATH: `${parent}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
        HOME: parent,
        HA_READOPTION_CONFIG: config,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${pathToFileURL(path.resolve("packages/daemon/test/fixtures/resident-readoption.fixture.ts")).href}`,
        ]
          .filter(Boolean)
          .join(" "),
      };
      for (const key of [
        "HARNESS_ACTOR",
        "HARNESS_EXECUTION_CREDENTIAL",
        "HARNESS_DAEMON_ENDPOINT",
        "HARNESS_DAEMON_RELAY",
      ])
        delete env[key];
      const start = () =>
        spawn(
          process.execPath,
          [entry, "--service", ...(supervised ? ["--supervised"] : []), "--user-root", userRoot, "--daemon-id", repoId],
          { env, stdio: ["ignore", "ignore", "pipe"] },
        );
      const old = start(),
        oldExit = once(old, "exit");
      let stderr = "",
        successor: ReturnType<typeof start> | undefined,
        workerPid = 0;
      old.stderr!.on("data", (data) => {
        stderr += String(data);
      });
      try {
        await until(() => existsSync(sessionFile), `resident did not spawn session: ${stderr}`);
        const receipt = JSON.parse(readFileSync(sessionFile, "utf8"));
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        const sessionId = String(receipt.runtimeSessionId);
        await until(() => existsSync(cliBefore) && existsSync(providerPid), "runtime did not call CLI before upgrade");
        await until(
          () =>
            readDaemonLifecycleRecords(userRoot, repoId).some(
              (e) => e.event === "runtime_spawn" && e.runtimeSessionId === sessionId,
            ),
          "old resident did not own runtime",
        );
        workerPid = readDaemonLifecycleRecords(userRoot, repoId).find(
          (e) => e.event === "runtime_spawn" && e.runtimeSessionId === sessionId,
        )!.pid!;
        const started = Date.now(),
          diskEntry = readFileSync(entry, "utf8"),
          replacementEntry = diskEntry.replace(
            /^(#![^\n]*\n)/u,
            `$1await import("node:fs").then(({ writeFileSync }) => writeFileSync(${JSON.stringify(buildWitness)}, String(process.pid)));\n`,
          );
        assert.notEqual(replacementEntry, diskEntry, "the disk build must contain a new entry");
        writeFileSync(entry, replacementEntry);
        writeFileSync(marker, "build-b\n");
        await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2000, 2000, undefined, true);
        if (!supervised && !failSuccessor) {
          await until(() => existsSync(failureEntered), "failed drain did not enter successor preparation");
          const contender = await acquireDaemonSingleton({ userRoot, daemonId: repoId, endpoint });
          assert.deepEqual(
            contender,
            { claim: "incumbent", pid: old.pid, witness: failDeadline ? "unix-socket" : "singleton-lock" },
            "a competing daemon must not acquire the writer slot while the failed resident is alive",
          );
          assert.equal(
            readDaemonSingletonLockPid(userRoot, repoId),
            old.pid,
            "the resident must retain its writer claim",
          );
          writeFileSync(failureRelease, "release");
        }
        const outcome = await oldExit;
        assert.deepEqual(outcome, [supervised ? 75 : 1, null], stderr);
        if (failDrain) assert.match(stderr, /injected resident drain failure/u);
        if (failSuccessor) assert.match(stderr, /injected successor callback failure/u);
        if (failDeadline) {
          const deadline = readDaemonLifecycleRecords(userRoot, repoId).find(
            (e) => e.event === "process_exit" && e.outcome === "shutdown_deadline_exceeded",
          );
          assert.equal(deadline?.reason, "build_superseded");
          assert.equal(deadline?.durationMs, 100);
        }
        assert.doesNotThrow(() => process.kill(workerPid, 0));
        if (supervised) successor = start();
        let successorError = "";
        successor?.stderr!.on("data", (data) => {
          successorError += String(data);
        });
        await until(
          () =>
            readDaemonLifecycleRecords(userRoot, repoId).filter(
              (e) => e.event === "runtime_spawn" && e.runtimeSessionId === sessionId,
            ).length >= 2,
          `new resident did not adopt runtime: ${successorError}`,
        );
        await until(() => existsSync(cliAfter), `runtime CLI did not recover: ${successorError}`);
        if (fakeService) assert.ok(existsSync(managerSeen), "the installed service manager must own the successor");
        await until(() => existsSync(buildWitness), "the successor did not execute the replaced disk entry");
        assert.equal(
          Number(readFileSync(buildWitness, "utf8")),
          readDaemonPid(userRoot, repoId),
          "the new daemon must execute the replaced entry itself",
        );
        const records = readDaemonLifecycleRecords(userRoot, repoId),
          spawns = records.filter((e) => e.event === "runtime_spawn" && e.runtimeSessionId === sessionId),
          starts = records.filter((e) => e.event === "process_start"),
          recoveryMs = Number(readFileSync(cliAfter, "utf8")) - started;
        assert.ok(
          starts.some((e) => e.pid === old.pid) && starts.some((e) => e.pid !== old.pid),
          "adoption must cross resident processes",
        );
        assert.deepEqual(
          spawns.map((e) => e.pid),
          [workerPid, workerPid],
          "the same worker must be adopted exactly once",
        );
        assert.ok(recoveryMs >= 0 && recoveryMs < 30_000, `runtime CLI recovery took ${recoveryMs}ms`);
        console.log(
          `real resident runtime CLI recovered in ${recoveryMs}ms (${supervised ? "supervised" : "on-demand"}, ${failDrain ? "failed drain" : "normal drain"})`,
        );
        const projection = makeTaskProjection({
          rootDir,
          projectionPath: path.join(parent, "live.sqlite"),
          eventStore: makeTaskEventReader({ repoId, rootDir }),
        });
        projection.catchUp();
        assert.deepEqual(
          {
            liveness: projection.readRuntimeSession(sessionId)!.liveness,
            outcome: projection.readRuntimeSession(sessionId)!.outcome,
          },
          { liveness: "live", outcome: null },
        );
        projection.close();
        if (!supervised && !fakeService && !failSuccessor) {
          // The failure successor must not retain its private wait-for-parent flag into a later upgrade.
          writeFileSync(marker, "build-c\n");
          await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2000, 2000, undefined, true);
          await until(
            () =>
              readDaemonLifecycleRecords(userRoot, repoId).filter(
                (e) => e.event === "runtime_spawn" && e.runtimeSessionId === sessionId,
              ).length === 3,
            "second successor did not adopt the same runtime",
          );
          const third = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2000, 2000, undefined, true);
          assert.equal((third.build as { loadedBuildId?: string }).loadedBuildId, "build-c");
          assert.doesNotThrow(() => process.kill(workerPid, 0));
        }
        writeFileSync(release, "release");
        await until(
          () =>
            makeTaskEventReader({ repoId, rootDir })
              .read()
              .events.some(
                (e) => e.type === "runtime_session_outcome_observed" && e.payload.runtimeSessionId === sessionId,
              ),
          "new resident did not settle runtime",
        );
        const settled = makeTaskProjection({
          rootDir,
          projectionPath: path.join(parent, "settled.sqlite"),
          eventStore: makeTaskEventReader({ repoId, rootDir }),
        });
        settled.catchUp();
        assert.deepEqual(
          {
            liveness: settled.readRuntimeSession(sessionId)!.liveness,
            outcome: settled.readRuntimeSession(sessionId)!.outcome,
          },
          { liveness: "exited", outcome: "succeeded" },
        );
        settled.close();
      } finally {
        old.kill("SIGKILL");
        successor?.kill("SIGTERM");
        if (!supervised) {
          const pid = readDaemonPid(userRoot, repoId);
          if (pid && pid !== old.pid) {
            killIfAlive(pid, "SIGTERM");
            await waitForArrival(
              () => (readDaemonPid(userRoot, repoId) === null ? true : null),
              (arrive) => {
                const watcher = watch(userRoot, arrive);
                return () => watcher.close();
              },
            );
          }
        }
        if (workerPid) killIfAlive(-workerPid, "SIGKILL");
        await oldExit;
        if (successor && successor.exitCode === null && successor.signalCode === null) await once(successor, "exit");
        rmSync(parent, { recursive: true, force: true });
        rmSync(buildRoot, { recursive: true, force: true });
      }
    },
  );
}
