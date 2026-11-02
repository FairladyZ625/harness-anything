// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";
import { daemonProtocolCommands } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";

test("storage migration projects all cold-switch inputs to the authorized daemon Action", () => {
  const argv = [
      "migrate",
      "storage",
      "--from",
      "sqlite",
      "--to",
      "postgres",
      "--source",
      "source.json",
      "--target",
      "target.json",
      "--run-id",
      "switch-1",
      "--export-directory",
      "export",
      "--mode",
      "resume",
    ],
    parsed = parseThinCommand(argv);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "repo.task.run");
  assert.deepEqual(parsed.command.action, {
    kind: "migrate-storage",
    from: "sqlite",
    to: "postgres",
    sourceLocation: "source.json",
    targetLocation: "target.json",
    runId: "switch-1",
    exportDirectory: "export",
    mode: "resume",
  });
  const descriptor = daemonProtocolCommands.find((command) => command.id === "migrate-storage")!;
  assert.equal(descriptor.commandClass, "admin");
  assert.equal(descriptor.repoCellExecution, "writer");
  assert.match(renderThinHelp([], "migrate"), /migrate storage/);
  assert.equal(parseThinCommand(argv.filter((value) => value !== "switch-1")).ok, false);
  assert.equal(parseThinCommand([...argv, "--force"]).ok, false);
  assert.equal(parseThinCommand(argv.map((value) => (value === "resume" ? "dual-write" : value))).ok, false);
});
