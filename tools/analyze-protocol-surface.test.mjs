// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeProtocolSurface } from "./analyze-protocol-surface.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeFixtureFiles(rootDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
}

test("detects duplicate CLI/GUI protocol glue and browser streaming gaps on fixture tree", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "protocol-surface-dup-"));
  try {
    writeFixtureFiles(fixture, {
      "packages/kernel/src/domain/action-declaration.ts": `
        const canonical = (kind, catalogId, cls) => ({ kind, catalogId, cls });
        export const actionDeclarations = [
          canonical("task-start", "task/start", "repo-write"),
          canonical("task-archive", "task/archive", "repo-write"),
        ];
      `,
      "packages/daemon/src/daemon-host/protocol/daemon-protocol-commands-task.ts": `
        export const cmds = [
          defineLedgerWriteCommand({
            id: "task-start",
            actionKind: "task-start",
            method: "repo.task.run",
            path: ["task", "start", "<task-id>"],
          }),
        ];
      `,
      "packages/daemon/src/daemon-host/protocol/daemon-protocol-action-routes.ts": `
        export const daemonActionRoutes = [
          guiAction("task.start", "repo.task.start", "task-start", shape({}), "startTask", "/api/tasks/:taskId/start", "repo-write"),
        ];
        export const daemonStreamFacets = [
          { id: "agentRuntime.attach", method: "repo.agentRuntime.attach", eventMethod: "repo.agentRuntime.attach.frame" },
          { id: "terminal.attach", method: "repo.terminal.attach", guiBridgeMethod: "attachTerminal" },
        ];
      `,
      "packages/daemon/src/daemon-host/protocol/daemon-protocol-read-routes.ts": `
        export const daemonReadRoutes = [
          { id: "gui.system.read", method: "daemon.gui.system.read", guiBridgeMethod: "getSystemStatus", path: "/api/system" },
        ];
      `,
      "packages/gui/src/api/api-contract-registry.ts": `
        import { daemonReadRoutes, daemonActionRoutes } from "@harness-anything/daemon/protocol";
        export const apiRouteContracts = [...daemonReadRoutes, ...daemonActionRoutes];
      `,
      "packages/gui/src/api/service-bridge.ts": `
        import { interactiveRpcMethods } from "@harness-anything/daemon/protocol";
        export const routes = interactiveRpcMethods;
      `,
      "packages/gui/src/preload/allowlist.ts": `
        import { interactiveRpcMethods, daemonGuiStreamFacets } from "@harness-anything/daemon/protocol";
        export const allow = [...interactiveRpcMethods, ...daemonGuiStreamFacets];
      `,
      "packages/gui/src/browser/browser-gui-transport.ts": `
        export function createBrowserGuiTransport() {
          const unavailable = { status: "unavailable", reason: "Available in the desktop app only." } as const;
          return {
            capabilities: () => ({ stream: unavailable }),
          };
        }
      `,
      "packages/cli/src/cli/gui-browser-broker.ts": `
        export function handle(req) {
          if (req.url === "/rpc") return isDaemonReadRoute(req.method) || isDaemonActionRoute(req.method);
        }
      `,
    });

    const first = analyzeProtocolSurface(fixture);
    const second = analyzeProtocolSurface(fixture);
    assert.deepEqual(first, second, "analyzer output must be deterministic");

    assert.equal(first.counts.duplicateCliGuiGlue, 1);
    assert.equal(first.duplicateCliGuiGlue[0].guiMethod, "repo.task.start");
    assert.equal(first.duplicateCliGuiGlue[0].actionKind, "task-start");
    assert.deepEqual(first.duplicateCliGuiGlue[0].cliCommandIds, ["task-start"]);
    assert.equal(first.duplicateCliGuiGlue[0].layers.length, 6);

    assert.equal(first.counts.guiOnlyFacets, 1);
    assert.equal(first.guiOnlyFacets[0].guiMethod, "daemon.gui.system.read");

    const gapIds = first.streamingSurface.gaps.map((g) => g.id);
    assert.deepEqual(gapIds, [
      "browser-broker-rpc-post-only",
      "browser-parity-missing-stream:repo.terminal.attach",
      "browser-transport-stream-unavailable",
      "stream-facet-missing-gui-bridge:repo.agentRuntime.attach",
    ]);

    const cliRun = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "tools/analyze-protocol-surface.mjs"), "--root", fixture, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const parsed = JSON.parse(cliRun.stdout);
    assert.deepEqual(parsed, first);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("negative control: converged surface reports zero duplicate glue and zero browser streaming gaps", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "protocol-surface-clean-"));
  try {
    writeFixtureFiles(fixture, {
      "packages/kernel/src/domain/action-declaration.ts": `
        export const actionDeclarations = [canonical("task-start", "task/start", "repo-write")];
      `,
      "packages/daemon/src/daemon-host/protocol/daemon-protocol-commands-task.ts": `
        export const cmds = [defineLedgerWriteCommand({ id: "task-start", actionKind: "task-start", method: "repo.task.run", path: ["task", "start"] })];
      `,
      "packages/daemon/src/daemon-host/protocol/daemon-protocol-action-routes.ts": `
        export const daemonActionRoutes = [];
        export const daemonStreamFacets = [
          { id: "terminal.attach", method: "repo.terminal.attach", guiBridgeMethod: "attachTerminal" },
        ];
      `,
      "packages/gui/src/browser/browser-gui-transport.ts": `
        export function createBrowserGuiTransport() {
          return {
            capabilities: () => ({ stream: { status: "available" } }),
            stream: () => new EventSource("/stream"),
          };
        }
      `,
      "packages/cli/src/cli/gui-browser-broker.ts": `
        export function handle(req) {
          if (req.url === "/stream") return "text/event-stream";
        }
      `,
    });

    const report = analyzeProtocolSurface(fixture);
    assert.equal(report.counts.duplicateCliGuiGlue, 0);
    assert.equal(report.counts.browserStreamingGaps, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// dec_89D06D7360CBEC09795F7B12EC/CH3: the legacy fixtures above still catch a resurrected shadow.
test("live repository has one protocol surface and matching stream transports", () => {
  const report = analyzeProtocolSurface(REPO_ROOT);
  assert.equal(report.schema, "protocol-surface-analysis/v1");
  assert.equal(report.counts.daemonGuiShadowFiles, 0);
  assert.equal(report.counts.duplicateCliGuiGlue, 0);
  assert.equal(report.counts.browserStreamingGaps, 0);
  assert.equal(report.counts.daemonStreamFacets, 2);
  assert.ok(report.counts.guiActionFacets > 0, "the analyzer must still inspect the canonical action routes");
});
