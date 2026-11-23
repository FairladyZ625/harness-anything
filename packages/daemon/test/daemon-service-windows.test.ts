// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  daemonServiceCommands,
  daemonServiceUnit,
  daemonServiceUnitContent,
  parseDaemonServiceState,
  runDaemonServiceCommand,
} from "../src/daemon-host/client/daemon-service.ts";
import { daemonStdioLogPath } from "../src/daemon-host/lifecycle-log.ts";

const target = { userRoot: "C:/Users/edge/user root", daemonId: "edge-a" },
  launch = {
    ...target,
    execPath: "C:/Program Files/nodejs/node.exe",
    entry: "C:/R&D/ha's/daemon.js",
    searchPath: "C:/node;C:/git",
  };
const decodedCommand = (command: readonly string[]) => Buffer.from(command.at(-1)!, "base64").toString("utf16le");

test("Windows owns one least-privilege scheduled task per local daemon target", () => {
  const unit = daemonServiceUnit(target, "win32")!;
  assert.equal(unit.manager, "task-scheduler");
  assert.equal(unit.unitPath, path.join(target.userRoot, "services", `${unit.name}.xml`));
  assert.notEqual(unit.name, daemonServiceUnit({ ...target, daemonId: "edge-b" }, "win32")!.name);
  assert.notEqual(unit.name, daemonServiceUnit({ ...target, userRoot: "C:/other" }, "win32")!.name);
  const content = daemonServiceUnitContent(unit, { ...launch, extraCaCerts: "certs/a'b.pem" });
  assert.match(content, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege/);
  assert.match(content, /<LogonTrigger>/);
  assert.match(content, /<ExecutionTimeLimit>PT0S/);
  assert.match(content, /<MultipleInstancesPolicy>IgnoreNew/);
  // RestartOnFailure never fires for an action's non-zero process exit, so the launcher script owns
  // the supersession relaunch and the XML must not claim restart behavior it does not have.
  assert.ok(!content.includes("<RestartOnFailure>"));
  assert.ok(!daemonServiceUnitContent(unit, { ...launch, runAtLogin: false }).includes("LogonTrigger"));
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(content)![1]!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.ok(script.includes("$env:PATH = 'C:/node;C:/git'"));
  assert.ok(script.includes("'C:/R&D/ha''s/daemon.js'"));
  assert.ok(script.includes("'--supervised'"));
  assert.ok(script.includes(`>> '${daemonStdioLogPath(target.userRoot, target.daemonId)}' 2>&1`));
  assert.ok(script.includes(path.resolve("certs/a'b.pem").replaceAll("'", "''")));
  assert.match(script, /for \(;;\) \{\r?\n\s*& '/u);
  assert.match(script, /if \(\$LASTEXITCODE -ne 75\) \{ exit \$LASTEXITCODE \}\r?\n\}/u);
  assert.ok(!daemonServiceUnitContent(unit, launch).includes("NODE_EXTRA_CA_CERTS"));
});

test("Windows registers, starts, queries and removes only its named task", () => {
  const unit = daemonServiceUnit(target, "win32")!,
    commands = daemonServiceCommands(unit);
  for (const command of [...commands.load, commands.start, commands.state, commands.unload]) {
    assert.deepEqual(command.slice(0, 6), [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
    ]);
    assert.ok(decodedCommand(command).includes(unit.name));
    assert.ok(decodedCommand(command).startsWith("$ErrorActionPreference = 'Stop'"));
  }
  assert.equal(commands.load.length, 1);
  assert.ok(decodedCommand(commands.load[0]!).includes(", 6, $null, $null, 3)"));
  assert.ok(decodedCommand(commands.load[0]!).includes("$d.Principal.UserId = $user"));
  assert.ok(decodedCommand(commands.load[0]!).includes("$trigger.UserId = $user"));
  assert.ok(decodedCommand(commands.start).includes(".Run($null)"));
  assert.ok(decodedCommand(commands.state).includes("$r.EnginePID"));
  assert.ok(decodedCommand(commands.state).includes("ParentProcessId"));
  assert.ok(decodedCommand(commands.unload).includes(".Stop(0)"));
  assert.ok(decodedCommand(commands.unload).includes("DeleteTask"));
});

test("Windows supervision reports the scheduler launcher's daemon child, not its own pid file", () => {
  assert.deepEqual(parseDaemonServiceState("task-scheduler", { exitCode: 0, stdout: "loaded=true\r\npid=4242\r\n" }), {
    loaded: true,
    pid: 4242,
  });
  assert.deepEqual(parseDaemonServiceState("task-scheduler", { exitCode: 0, stdout: "loaded=true\r\n" }), {
    loaded: true,
    pid: null,
  });
  assert.deepEqual(parseDaemonServiceState("task-scheduler", { exitCode: 0, stdout: "loaded=false\r\n" }), {
    loaded: false,
    pid: null,
  });
  assert.throws(
    () => parseDaemonServiceState("task-scheduler", { exitCode: 1, stdout: "query failed" }),
    /query failed/,
  );
  assert.throws(
    () => parseDaemonServiceState("task-scheduler", { exitCode: 1, stdout: "", stderr: "COM access denied" }),
    /COM access denied/,
  );
});

test("Windows Schedule.Service command retries transient COM/timeout failures and enforces 30s timeout floor", async () => {
  const unit = daemonServiceUnit(target, "win32")!,
    command = daemonServiceCommands(unit).load[0]!,
    observedTimeouts: Array<number | undefined> = [],
    delays: number[] = [];
  let calls = 0;

  await runDaemonServiceCommand(command, 10_000, {
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    runner: async (_cmd, _args, _cwd, _env, _input, _signal, options) => {
      calls += 1;
      observedTimeouts.push(options?.timeoutMs);
      if (calls === 1) {
        return { exitCode: 1, stdout: "", stderr: "COM error 0x80070422: Schedule.Service busy" };
      }
      if (calls === 2) {
        const timeoutError = Object.assign(new Error("Command failed: powershell.exe"), {
          killed: true,
          signal: "SIGKILL",
          stdout: "connecting...",
          stderr: "RegisterTaskDefinition timed out",
        });
        throw timeoutError;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(observedTimeouts, [30_000, 30_000, 30_000]);
  assert.deepEqual(delays, [375, 625]);
});

test("Windows Schedule.Service command fails closed after exhaustion with full exitCode, stderr, and stdout", async () => {
  const unit = daemonServiceUnit(target, "win32")!,
    command = daemonServiceCommands(unit).start;
  let calls = 0;

  await assert.rejects(
    () =>
      runDaemonServiceCommand(command, 10_000, {
        sleep: async () => undefined,
        random: () => 0,
        runner: async () => {
          calls += 1;
          return {
            exitCode: 1,
            stdout: "attempt-stdout-snippet",
            stderr: "Exception calling RegisterTaskDefinition with 6 argument(s): Access is denied",
          };
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exitCode=1/u);
      assert.match(error.message, /attempts=3/u);
      assert.match(error.message, /RegisterTaskDefinition/u);
      assert.match(error.message, /attempt-stdout-snippet/u);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("Windows Schedule.Service command does not retry permanent ENOENT spawn errors and preserves error.code", async () => {
  const unit = daemonServiceUnit(target, "win32")!,
    command = daemonServiceCommands(unit).start;
  let calls = 0;

  await assert.rejects(
    () =>
      runDaemonServiceCommand(command, 10_000, {
        sleep: async () => undefined,
        runner: async () => {
          calls += 1;
          throw Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "ENOENT");
      assert.match(error.message, /code=ENOENT/u);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("POSIX service commands do not retry and preserve exact caller timeout", async () => {
  const observedTimeouts: Array<number | undefined> = [];
  let calls = 0;

  await assert.rejects(
    () =>
      runDaemonServiceCommand(["systemctl", "--user", "start", "ha.service"], 1_000, {
        sleep: async () => undefined,
        runner: async (_cmd, _args, _cwd, _env, _input, _signal, options) => {
          calls += 1;
          observedTimeouts.push(options?.timeoutMs);
          return { exitCode: 1, stdout: "", stderr: "Failed to start ha.service" };
        },
      }),
    /Failed to start ha\.service/u,
  );
  assert.equal(calls, 1);
  assert.deepEqual(observedTimeouts, [1_000]);
});
