// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { observeProviderFault } from "../src/runtime-provider-fault.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { tasklessSettlementRuntime } from "./runtime-spawn-settlement.fixtures.ts";

const blocked = {
  type: "command_execution",
  command: "rg --files --hidden",
  status: "failed",
  exit_code: null,
  aggregated_output: "rejected: blocked by policy",
};
const policyRejection =
  'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(blocked by policy)" }';
const read = {
  type: "command_execution",
  command: "Get-Content evidence.txt",
  status: "completed",
  exit_code: 0,
  aggregated_output: "review evidence",
};

for (const scenario of [
  { name: "policy rejection before any command frame", items: [], stderr: policyRejection, expected: "failed" },
  { name: "successful read after policy rejection", items: [read], stderr: policyRejection, expected: "succeeded" },
  { name: "every command blocked", items: [blocked], expected: "failed" },
  {
    name: "successful web search with local commands blocked",
    items: [{ type: "web_search", results: [] }, blocked],
    expected: "failed",
  },
  { name: "successful local retry after a blocked command", items: [blocked, read], expected: "succeeded" },
  { name: "failed command after a successful local read", items: [read, blocked], expected: "succeeded" },
  { name: "no local command attempted", items: [], expected: "succeeded" },
  { name: "another provider", kindId: "claude", items: [blocked], expected: "succeeded" },
  { name: "implementation worker", role: "worker", items: [blocked], expected: "succeeded" },
] as const)
  test(`taskless read-only reviewer settlement: ${scenario.name}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-reviewer-evidence-"));
    try {
      const outcomes: Record<string, unknown>[] = [],
        runtime = tasklessSettlementRuntime(rootDir, "review result");
      runtime.role = "role" in scenario ? scenario.role : "reviewer";
      runtime.kindId = "kindId" in scenario ? scenario.kindId : "codex";
      runtime.permissionMode = "read-only";
      runtime.providerOutcome = "succeeded";
      runtime.errorBuffer = "stderr" in scenario ? scenario.stderr : "";
      // Replay the provider's structured tool results, including the start of a command
      // that may never complete. Neither a final message nor exit 0 witnesses a read.
      for (const item of scenario.items) {
        observeProviderFault(runtime, parseProviderFrame("codex", { type: "item.started", item }));
        observeProviderFault(runtime, parseProviderFrame("codex", { type: "item.completed", item }));
      }
      const context = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-11-03T00:01:00.000Z",
          stream: { publish: () => ({}) },
          remote: { archive: async () => ({ outcome: "applied" }) },
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => runtime.finalText ?? "",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
          if (type === "runtime_session_outcome_observed") outcomes.push(payload);
          return {};
        },
        settleFallback: async () => undefined,
      } as unknown as RuntimeSpawnerContext;

      await publishExit(context, runtime, 0);
      assert.equal(outcomes[0]?.outcome, scenario.expected);
      if (scenario.expected === "failed") {
        const attempt = outcomes[0]?.attempt as { classification: string; reason: string };
        assert.equal(attempt.classification, "gate_red");
        assert.match(attempt.reason, /no successful local command evidence/u);
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
