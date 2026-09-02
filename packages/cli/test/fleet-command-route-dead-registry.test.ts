// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetEdgeRegistration } from "../src/daemon/fleet-command-route.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";

// 2026-09-02 现场:一条指向已删临时目录的 e2e 残留登记(甚至已 disabled)让每一条走路由的
// ha 命令都报 invalid_root。路由只关心 enabled 且根目录还在的条目,其余必须被忽略。
test("a registered repo whose root no longer exists does not break routing for other repos", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-dead-registry-"));
  const liveRoot = path.join(userRoot, "live-repo");
  mkdirSync(liveRoot);
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v1",
      repos: [
        { repoId: "dead-disabled", canonicalRoot: "/nonexistent/parent/dead-one", state: "disabled", mode: "local" },
        { repoId: "dead-enabled", canonicalRoot: "/nonexistent/parent/dead-two", state: "enabled", mode: "local" },
        { repoId: "live", canonicalRoot: liveRoot, state: "enabled", mode: "local" },
      ],
    }),
  );
  const command = { rootDir: liveRoot } as ThinCommand;
  // local mode → no fleet reroute; the point is that it resolves instead of throwing invalid_root.
  assert.equal(await fleetEdgeRegistration(command, { HARNESS_DAEMON_USER_ROOT: userRoot }), null);
});
