// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  daemonServiceCommands,
  daemonServiceUnit,
  daemonServiceUnitContent,
  parseDaemonServiceState,
} from "../src/client/daemon-service.ts";
import { daemonStdioLogPath } from "../src/lifecycle-log.ts";

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
  assert.match(content, /<RestartOnFailure>/);
  assert.ok(!daemonServiceUnitContent(unit, { ...launch, runAtLogin: false }).includes("LogonTrigger"));
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(content)![1]!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.ok(script.includes("$env:PATH = 'C:/node;C:/git'"));
  assert.ok(script.includes("'C:/R&D/ha''s/daemon.js'"));
  assert.ok(script.includes("'--supervised'"));
  assert.ok(script.includes(`>> '${daemonStdioLogPath(target.userRoot, target.daemonId)}' 2>&1`));
  assert.ok(script.includes(path.resolve("certs/a'b.pem").replaceAll("'", "''")));
  assert.ok(script.endsWith("exit $LASTEXITCODE"));
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
});
