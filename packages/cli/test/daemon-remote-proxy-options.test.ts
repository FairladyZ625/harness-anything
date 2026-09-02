// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runDaemonControl } from "../src/daemon/control.ts";

test("daemon remote-proxy registration validates root and endpoint ownership before dialing", async () => {
  const cases = [
    {
      argv: [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        "remote",
        "--mode",
        "remote-proxy",
        "--root",
        "/tmp/repo",
        "--endpoint",
        "tcp://127.0.0.1:9911",
      ],
      code: "invalid_field",
      hint: /omits --root/u,
    },
    {
      argv: ["daemon", "repo", "register", "--repo-id", "local"],
      code: "invalid_field",
      hint: /requires --root/u,
    },
    {
      argv: [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        "remote",
        "--mode",
        "remote-proxy",
        "--endpoint",
        "tcp://127.0.0.1:9911",
        "--connection",
        "server",
      ],
      code: "invalid_field",
      hint: /exactly one/u,
    },
  ] as const;
  for (const expected of cases) {
    const receipts: Record<string, unknown>[] = [],
      exit = await runDaemonControl(expected.argv, (receipt) => receipts.push(receipt));
    assert.equal(exit, 2);
    assert.equal(receipts[0]?.code, expected.code);
    assert.match(String(receipts[0]?.nextAction), expected.hint);
  }
});

test("daemon connection and repo update options reject missing or invalid fields before dialing", async () => {
  for (const argv of [
    ["daemon", "connection", "add"],
    ["daemon", "connection", "update"],
    ["daemon", "connection", "remove"],
    ["daemon", "connection", "probe"],
    ["daemon", "connection", "update", "--connection", "server", "--state", "paused"],
    ["daemon", "repo", "update", "--repo-id", "remote", "--mode", "unknown"],
  ]) {
    const receipts: Record<string, unknown>[] = [],
      exit = await runDaemonControl(argv, (receipt) => receipts.push(receipt));
    assert.equal(exit, 2, argv.join(" "));
    assert.ok(receipts[0]?.code === "missing_field" || receipts[0]?.code === "invalid_field");
  }
});
