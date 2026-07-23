// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePreKillDiagnostics,
  selectStallDiagnosticTargets
} from "./node-test-stall-diagnostics.mjs";

const repoRoot = "/repo";

test("stall diagnostics select the host, every isolation child, and the deepest futex descendant", () => {
  const members = [
    member(100, 1, "ep_poll", "node --test packages/a.test.ts"),
    member(101, 100, "ep_poll", "node --test-isolation=process packages/a.test.ts"),
    member(102, 101, "futex_do_wait", "node tools/helper.mjs"),
    member(103, 100, "futex_do_wait", "node --test-isolation=process packages/b.test.ts")
  ];

  const selection = selectStallDiagnosticTargets(members, 100, repoRoot, 103);

  assert.equal(selection.reportTarget.pid, 102);
  assert.deepEqual(selection.targets.map(({ pid, role }) => ({ pid, role })), [
    { pid: 100, role: "test-host" },
    { pid: 101, role: "isolation-child" },
    { pid: 103, role: "isolation-child" },
    { pid: 102, role: "wedged-descendant" }
  ]);
});

test("pre-kill diagnostics signal only the deepest target and report bounded absence", async () => {
  const lines = [];
  const signals = [];

  await capturePreKillDiagnostics({
    members: [
      member(200, 1, "ep_poll", "node --test packages/a.test.ts"),
      member(201, 200, "futex_do_wait", "node --test-isolation=process packages/a.test.ts")
    ],
    hostPid: 200,
    repoRoot,
    reportDirectory: "/missing-report-directory",
    preferredPid: 201,
    platform: "test-platform",
    reportGraceMs: 1,
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    writeLine: (line) => lines.push(line)
  });

  assert.deepEqual(signals, [{ pid: 201, signal: "SIGUSR2" }]);
  assert.match(lines.join("\n"), /grace=1ms/u);
  assert.match(lines.join("\n"), /\/proc diagnostics unavailable on platform test-platform/u);
  assert.match(lines.join("\n"), /diagnostic report: no new file within 1ms/u);
});

function member(pid, ppid, waitChannel, command) {
  return { pid, ppid, pgid: 100, waitChannel, command };
}
