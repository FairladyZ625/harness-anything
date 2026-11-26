// harness-test-tier: fast
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exitNotificationCommand,
  launchExitNotification,
  liveDescendantPidsOf,
} from "../src/daemon-host/runtime-spawn-process.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function withPlatform(t: test.TestContext, value: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value });
  t.after(() => Object.defineProperty(process, "platform", original));
}

function withEnv(t: test.TestContext, overrides: Readonly<Record<string, string>>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("exitNotificationCommand routes Windows .cmd/.bat shims through cmdShellInvocation with percent neutralization", (t) => {
  withPlatform(t, "win32");
  const cmdShim = exitNotificationCommand("C:\\Tools\\notify.cmd", {
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(cmdShim, {
    executablePath: "C:\\Windows\\System32\\cmd.exe",
    args: ["/e:ON", "/v:OFF", "/d", "/c", '""C:\\Tools\\notify.cmd""'],
    windowsVerbatimArguments: true,
  });

  const percentBat = exitNotificationCommand("C:\\Tools\\%PATH%\\notify.bat", {
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(percentBat, {
    executablePath: "C:\\Windows\\System32\\cmd.exe",
    args: ["/e:ON", "/v:OFF", "/d", "/c", '""C:\\Tools\\%%cd:~,%PATH%%cd:~,%\\notify.bat""'],
    windowsVerbatimArguments: true,
  });

  const fallback = exitNotificationCommand("C:\\Tools\\notify.cmd", {});
  assert.equal(fallback.executablePath, "cmd.exe");
  assert.deepEqual(fallback.args, ["/e:ON", "/v:OFF", "/d", "/c", '""C:\\Tools\\notify.cmd""']);

  const nativeExe = exitNotificationCommand("C:\\Tools\\notify.exe", {});
  assert.deepEqual(nativeExe, {
    executablePath: "C:\\Tools\\notify.exe",
    args: [],
    windowsVerbatimArguments: false,
  });
});

test("exitNotificationCommand preserves direct execution for POSIX commands", (t) => {
  withPlatform(t, "linux");
  assert.deepEqual(exitNotificationCommand("/usr/local/bin/notify.cmd", {}), {
    executablePath: "/usr/local/bin/notify.cmd",
    args: [],
    windowsVerbatimArguments: false,
  });
});

test("exitNotificationCommand rejects NUL, CR, LF, quotes, and trailing backslashes fail-closed", (t) => {
  withPlatform(t, "win32");
  const hostileCommands = [
    "C:\\Tools\\notify.cmd\r\necho pwned",
    "C:\\Tools\\notify.cmd\necho pwned",
    "C:\\Tools\\notify.cmd\recho pwned",
    "C:\\Tools\\notify.cmd\0echo pwned",
    "C:\\Tools\\bad\nnotify.cmd",
    "C:\\Tools\\bad\rnotify.cmd",
    "C:\\Tools\\bad\0notify.cmd",
    'C:\\Tools\\bad"quote.cmd',
    "C:\\Tools\\notify.exe\r\necho pwned",
  ];
  for (const hostile of hostileCommands) {
    assert.throws(
      () => exitNotificationCommand(hostile, { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: unknown }).code, "runtime_windows_cmd_argument_rejected");
        return true;
      },
      `expected fail-closed rejection for ${JSON.stringify(hostile)}`,
    );
  }
});

test("launchExitNotification refuses NUL/CR/LF commands without spawning a process", (t) => {
  withPlatform(t, "win32");
  const records: Array<Record<string, unknown>> = [];
  let spawned = false;
  t.mock.method(childProcess, "spawn", () => {
    spawned = true;
    throw new Error("spawn must not be called for rejected exit notification command");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  launchExitNotification({
    command: "C:\\Tools\\notify.cmd\r\necho pwned",
    cwd: tmpdir(),
    stream: {
      appendExitNotification: (value, occurredAt) => records.push({ ...value, occurredAt }),
    },
    payload: {
      schema: "runtime-session-exited/v1",
      runtimeSessionId: "runtime_rejected_cmd",
      outcome: "succeeded",
      exitCode: 0,
    },
    now: () => "2026-11-27T00:00:00.000Z",
  });

  assert.equal(spawned, false, "rejected command must never invoke spawn");
  assert.deepEqual(records, [
    {
      phase: "finished",
      started: false,
      exitCode: null,
      timedOut: false,
      errorCode: "runtime_windows_cmd_argument_rejected",
      occurredAt: "2026-11-27T00:00:00.000Z",
    },
  ]);
});

test(
  "launchExitNotification executes a valid Windows .cmd shim and delivers its JSON payload",
  { skip: process.platform === "win32" ? false : "requires real Windows cmd.exe .cmd shim execution" },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-exit-notify-cmd-")),
      capturedPath = path.join(root, "payload.json"),
      shim = writeProviderExecutable(
        path.join(root, "notify.mjs"),
        `import { writeFileSync } from "node:fs";\nlet body = "";\nfor await (const chunk of process.stdin) body += chunk;\nwriteFileSync(${JSON.stringify(capturedPath)}, body);\n`,
      ),
      records: Array<Record<string, unknown>> = [];
    t.after(() => removeTempRepository(root));

    assert.match(shim, /\.cmd$/iu);
    let resolveFinished!: (record: Record<string, unknown>) => void;
    const finishedPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveFinished = resolve;
    });
    launchExitNotification({
      command: shim,
      cwd: root,
      stream: {
        appendExitNotification: (value, occurredAt) => {
          const entry = { ...value, occurredAt };
          records.push(entry);
          if (value.phase === "finished") resolveFinished(entry);
        },
      },
      payload: {
        schema: "runtime-session-exited/v1",
        runtimeSessionId: "runtime_valid_cmd",
        outcome: "succeeded",
        exitCode: 0,
      },
      now: () => "2026-11-27T00:00:00.000Z",
      timeoutMs: 10_000,
    });

    const finished = await finishedPromise;
    assert.equal(finished.started, true);
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.timedOut, false);
    const payload = JSON.parse(readFileSync(capturedPath, "utf8")) as Record<string, unknown>;
    assert.equal(payload.runtimeSessionId, "runtime_valid_cmd");
    assert.equal(payload.outcome, "succeeded");
  },
);

test("readWindowsProcessRows trims the PowerShell environment block and strips host secrets", async (t) => {
  withPlatform(t, "win32");
  withEnv(t, {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: "C:\\Windows\\System32",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    OPENAI_API_KEY: "sk-secret-must-not-leak",
    GH_TOKEN: "ghp_secret_must_not_leak",
    HARNESS_GITHUB_TOKEN: "ghs_secret_must_not_leak",
    AWS_SECRET_ACCESS_KEY: "aws-secret-must-not-leak",
    HARNESS_TEST_TIER_MANIFEST: "x".repeat(80_000),
  });

  let capturedCommand: string | undefined;
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  t.mock.method(
    childProcess,
    "execFile",
    (
      file: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      capturedCommand = file;
      capturedEnv = options?.env;
      const child = Object.assign(new EventEmitter(), {
        pid: 9999,
        exitCode: 0,
        signalCode: null,
        stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
        kill: () => true,
      });
      queueMicrotask(() =>
        callback(
          null,
          JSON.stringify([
            { ProcessId: 100, ParentProcessId: 1 },
            { ProcessId: 200, ParentProcessId: 100 },
          ]),
          "",
        ),
      );
      return child as unknown as childProcess.ChildProcess;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const probe = await liveDescendantPidsOf(100);
  assert.deepEqual(probe, { available: true, pids: [200] });
  assert.equal(capturedCommand, "powershell.exe");
  assert.ok(capturedEnv, "powershell.exe probe must receive an explicit trimmed env block");

  const lowerKeys = new Set(Object.keys(capturedEnv).map((key) => key.toLowerCase()));
  for (const required of ["systemroot", "windir", "comspec", "pathext", "path", "temp", "tmp", "psmodulepath"])
    assert.equal(lowerKeys.has(required), true, `expected minimal Windows env key ${required}`);
  for (const stripped of [
    "OPENAI_API_KEY",
    "GH_TOKEN",
    "HARNESS_GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "HARNESS_TEST_TIER_MANIFEST",
  ])
    assert.equal(capturedEnv[stripped], undefined, `${stripped} must be stripped from powershell.exe probe env`);
});

test(
  "Windows liveDescendantPidsOf succeeds with Get-CimInstance under secrets and an >70KB parent env block",
  { skip: process.platform === "win32" ? false : "requires real Windows PowerShell Get-CimInstance", timeout: 60_000 },
  async (t) => {
    withEnv(t, {
      OPENAI_API_KEY: "sk-test-probe-secret",
      GH_TOKEN: "ghp_test_probe_secret",
      HARNESS_TEST_TIER_MANIFEST: "x".repeat(80_000),
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    t.after(async () => {
      child.kill();
      await once(child, "close").catch(() => undefined);
    });
    await once(child, "spawn");
    const probe = await liveDescendantPidsOf(process.pid);
    assert.equal(probe.available, true, "real Windows PowerShell Get-CimInstance probe must exit 0 with trimmed env");
    if (probe.available) assert.ok(probe.pids.includes(child.pid ?? -1));
  },
);
