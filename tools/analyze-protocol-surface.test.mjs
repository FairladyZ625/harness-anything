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
      "packages/daemon/src/protocol/daemon-protocol-commands-task.ts": `
        export const cmds = [
          defineLedgerWriteCommand({
            id: "task-start",
            actionKind: "task-start",
            method: "repo.task.run",
            path: ["task", "start", "<task-id>"],
          }),
        ];
      `,
      "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts": `
        export const daemonGuiActionMethods = [
          guiAction("task.start", "repo.task.start", "task-start", shape({}), "startTask", "/api/tasks/:taskId/start", "repo-write"),
        ];
        export const daemonStreamFacets = [
          { id: "agentRuntime.attach", method: "repo.agentRuntime.attach", eventMethod: "repo.agentRuntime.attach.frame" },
          { id: "terminal.attach", method: "repo.terminal.attach", guiBridgeMethod: "attachTerminal" },
        ];
      `,
      "packages/daemon/src/protocol/daemon-protocol-gui-reads.ts": `
        export const daemonGuiReadMethods = [
          { id: "gui.system.read", method: "daemon.gui.system.read", guiBridgeMethod: "getSystemStatus", path: "/api/system" },
        ];
      `,
      "packages/gui/src/api/api-contract-registry.ts": `
        import { daemonGuiReadMethods, daemonGuiActionMethods } from "@harness-anything/daemon/protocol";
        export const apiRouteContracts = [...daemonGuiReadMethods, ...daemonGuiActionMethods];
      `,
      "packages/gui/src/api/service-bridge.ts": `
        import { daemonGuiInvokeFacets } from "@harness-anything/daemon/protocol";
        export const routes = daemonGuiInvokeFacets;
      `,
      "packages/gui/src/preload/allowlist.ts": `
        import { daemonGuiInvokeFacets, daemonGuiStreamFacets } from "@harness-anything/daemon/protocol";
        export const allow = [...daemonGuiInvokeFacets, ...daemonGuiStreamFacets];
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
          if (req.url === "/rpc") return isDaemonGuiReadMethod(req.method) || isDaemonGuiActionMethod(req.method);
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
      "packages/daemon/src/protocol/daemon-protocol-commands-task.ts": `
        export const cmds = [defineLedgerWriteCommand({ id: "task-start", actionKind: "task-start", method: "repo.task.run", path: ["task", "start"] })];
      `,
      "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts": `
        export const daemonGuiActionMethods = [];
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

test("live repository protocol surface identifies duplicate glue and ARCH-006/ARCH-016 streaming gaps", () => {
  const report = analyzeProtocolSurface(REPO_ROOT);
  assert.equal(report.schema, "protocol-surface-analysis/v1");
  assert.ok(report.counts.daemonProtocolFiles >= 50);
  assert.ok(report.counts.daemonGuiShadowFiles >= 9);
  assert.ok(report.counts.duplicateCliGuiGlue > 0, "must report duplicate CLI/GUI protocol glue");
  assert.ok(
    report.duplicateCliGuiGlue.some(
      (entry) => entry.actionKind === "task-start" && entry.guiMethod === "repo.task.start",
    ),
    "expected task-start duplicate CLI/GUI mapping",
  );
  const gapIds = new Set(report.streamingSurface.gaps.map((g) => g.id));
  assert.ok(gapIds.has("browser-transport-stream-unavailable"));
  assert.ok(gapIds.has("browser-broker-rpc-post-only"));
  assert.ok(gapIds.has("stream-facet-missing-gui-bridge:repo.agentRuntime.attach"));
});
