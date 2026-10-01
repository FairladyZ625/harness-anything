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
import { localDaemonTargetKey } from "../src/client/local-daemon-target.ts";
import { daemonStdioLogPath } from "../src/lifecycle-log.ts";

const target = { userRoot: "/home/edge/.harness", daemonId: "default" },
  launch = {
    ...target,
    execPath: "/opt/node/bin/node",
    entry: "/opt/ha/daemon/dist/index.js",
    searchPath: "/opt/node/bin:/usr/bin",
  },
  output = daemonStdioLogPath(target.userRoot, target.daemonId),
  name = `harness-anything-daemon-${localDaemonTargetKey(target.userRoot, target.daemonId)}`;

test("the systemd user unit restarts only on failure and signals only the daemon process", () => {
  const unit = daemonServiceUnit(target, "linux", "/home/edge");
  assert.deepEqual(unit, {
    manager: "systemd",
    name,
    unitPath: path.join("/home/edge", ".config", "systemd", "user", `${name}.service`),
  });
  assert.equal(
    daemonServiceUnitContent(unit!, launch),
    [
      "[Unit]",
      "Description=Harness Anything daemon (default, /home/edge/.harness)",
      "",
      "[Service]",
      'ExecStart="/opt/node/bin/node" "/opt/ha/daemon/dist/index.js" "--service" "--user-root" "/home/edge/.harness" "--daemon-id" "default" "--supervised"',
      'Environment="PATH=/opt/node/bin:/usr/bin"',
      `StandardOutput=append:${output}`,
      `StandardError=append:${output}`,
      "Restart=on-failure",
      "KillMode=process",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
  assert.deepEqual(daemonServiceCommands(unit!, 1000), {
    load: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${name}.service`],
    ],
    unload: ["systemctl", "--user", "disable", "--now", `${name}.service`],
    start: ["systemctl", "--user", "start", `${name}.service`],
    state: ["systemctl", "--user", "show", `${name}.service`, "--property=LoadState,MainPID"],
  });
});

test("the launchd agent restarts only on failure and leaves the daemon's process group alone", () => {
  const unit = daemonServiceUnit(target, "darwin", "/Users/edge");
  assert.deepEqual(unit, {
    manager: "launchd",
    name,
    unitPath: path.join("/Users/edge", "Library", "LaunchAgents", `${name}.plist`),
  });
  assert.equal(
    daemonServiceUnitContent(unit!, launch),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${name}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>/opt/node/bin/node</string>",
      "    <string>/opt/ha/daemon/dist/index.js</string>",
      "    <string>--service</string>",
      "    <string>--user-root</string>",
      "    <string>/home/edge/.harness</string>",
      "    <string>--daemon-id</string>",
      "    <string>default</string>",
      "    <string>--supervised</string>",
      "  </array>",
      "  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/node/bin:/usr/bin</string></dict>",
      `  <key>StandardOutPath</key><string>${output}</string>`,
      `  <key>StandardErrorPath</key><string>${output}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
      "  <key>AbandonProcessGroup</key><true/>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  assert.deepEqual(daemonServiceCommands(unit!, 501), {
    load: [["launchctl", "bootstrap", "gui/501", unit!.unitPath]],
    unload: ["launchctl", "bootout", `gui/501/${name}`],
    start: ["launchctl", "kickstart", `gui/501/${name}`],
    state: ["launchctl", "print", `gui/501/${name}`],
  });
});

test("a unit is keyed by user root and daemon id, and no unit exists for an unsupported platform", () => {
  const again = daemonServiceUnit(target, "linux", "/home/edge"),
    otherRoot = daemonServiceUnit({ ...target, userRoot: "/home/edge/second" }, "linux", "/home/edge"),
    otherId = daemonServiceUnit({ ...target, daemonId: "second" }, "linux", "/home/edge");
  assert.deepEqual(again, daemonServiceUnit(target, "linux", "/home/edge"));
  assert.equal(new Set([again!.unitPath, otherRoot!.unitPath, otherId!.unitPath]).size, 3);
  assert.equal(daemonServiceUnit(target, "win32", "C:\\Users\\edge"), null);
});

test("paths that carry unit-file metacharacters are written as literal arguments", () => {
  const awkward = { ...launch, userRoot: '/home/a "b"/100%/$HOME\\x', entry: "/opt/R&D <ha>/index.js" };
  const systemd = daemonServiceUnitContent(daemonServiceUnit(awkward, "linux", "/home/edge")!, awkward),
    launchd = daemonServiceUnitContent(daemonServiceUnit(awkward, "darwin", "/Users/edge")!, awkward);
  assert.ok(systemd.includes('"/home/a \\"b\\"/100%%/$$HOME\\\\x"'), systemd);
  assert.ok(launchd.includes("<string>/opt/R&amp;D &lt;ha&gt;/index.js</string>"), launchd);
});

test("the service manager's own pid is what the unit state reports", () => {
  assert.deepEqual(parseDaemonServiceState("systemd", { exitCode: 0, stdout: "LoadState=loaded\nMainPID=4242\n" }), {
    loaded: true,
    pid: 4242,
  });
  assert.deepEqual(parseDaemonServiceState("systemd", { exitCode: 0, stdout: "LoadState=loaded\nMainPID=0\n" }), {
    loaded: true,
    pid: null,
  });
  assert.deepEqual(parseDaemonServiceState("systemd", { exitCode: 0, stdout: "LoadState=not-found\nMainPID=0\n" }), {
    loaded: false,
    pid: null,
  });
  const running = `gui/501/${name} = {\n\tactive count = 1\n\tstate = running\n\tpid = 977\n\tjetsam = {\n\t\tpid = 1\n\t}\n}\n`;
  assert.deepEqual(parseDaemonServiceState("launchd", { exitCode: 0, stdout: running }), { loaded: true, pid: 977 });
  assert.deepEqual(
    parseDaemonServiceState("launchd", { exitCode: 0, stdout: `gui/501/${name} = {\n\tstate = not running\n}\n` }),
    { loaded: true, pid: null },
  );
  assert.deepEqual(parseDaemonServiceState("launchd", { exitCode: 113, stdout: "" }), { loaded: false, pid: null });
});
