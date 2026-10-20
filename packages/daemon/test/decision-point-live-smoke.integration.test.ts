// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionPointBindingDigest,
  type AgentRuntimeEventV1,
  type VerticalDefinition,
} from "@harness-anything/kernel";
import type { CredentialPort } from "../src/agent-runtime-credential-port.ts";
import { openDecisionAnnotationStore } from "../src/decision-annotations.ts";
import { openDecisionPointExecutor } from "../src/decision-point-executor.ts";
import { openDecisionProviderService } from "../src/decision-provider.ts";
import type { RepoCell } from "../src/repo-cell-types.ts";

const dispatchId = "dispatch_live_smoke_20261019",
  pointId = "dispatch-stop-reason",
  vertical = JSON.parse(
    readFileSync(new URL("../../preset/assets/software-coding/vertical.json", import.meta.url), "utf8"),
  ) as VerticalDefinition,
  decisions = vertical.decisions,
  point = decisions?.points[pointId],
  question = point && decisions?.questions[point.question],
  apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";

test(
  "live Decisions provider records a real final dispatch.settled advisory and egress receipt",
  { skip: apiKey ? false : "set OPENROUTER_API_KEY from an approved 0600 secret file to run the live smoke" },
  async (t) => {
    assert.ok(decisions && point && question, "software-coding vertical must declare the smoke point and question");
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-point-live-smoke-")),
      credentials = new Map<string, string>();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let referenceNumber = 0;
    const vault: CredentialPort = {
      issue: () => `credential:v1:decision-smoke-${++referenceNumber}`,
      store: async (reference, secret) => void credentials.set(reference, secret),
      resolve: async (reference) => {
        const secret = credentials.get(reference);
        if (!secret) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
        return secret;
      },
      remove: async (reference) => void credentials.delete(reference),
    };
    const providers = openDecisionProviderService({ userRoot: rootDir, vault }),
      providerId = "dp-openrouter-mercury",
      model = "inception/mercury-decide:free";
    await providers.command({
      kind: "provider-create",
      type: "decisions",
      providerId,
      name: "Isolated dispatch settlement smoke",
      model,
      apiKey,
    });
    const providerFile = path.join(rootDir, "decision-providers.json");
    assert.equal(statSync(providerFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(providerFile, "utf8").includes(apiKey), false);

    const binding = `${pointId}@${decisionPointBindingDigest(pointId, point, question).slice(0, 12)}`,
      report = "Worker stopped after the package registry rejected a publish request.",
      reason = "package registry rejected the publish request",
      outcome = {
        schema: "agent-runtime-event/v1",
        type: "runtime_session_outcome_observed",
        occurredAt: new Date().toISOString(),
        payload: {
          runtimeSessionId: "runtime-live-smoke",
          outcome: "failed",
          exitCode: 1,
          resultRef: `artifact:runtime-result/sha256/${"a".repeat(64)}`,
          result: { sha256: "a".repeat(64), size: report.length, mediaType: "text/plain" },
          dispatchId,
          endedAt: new Date().toISOString(),
          attempt: { classification: "worker_stop", reason },
        },
      } as Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>,
      cell = {
        read: async (method: string) => {
          if (method === "repo.agentRuntime.sessions.read")
            return {
              status: "ready",
              session: { associations: [{ taskId: "task-live-smoke" }] },
              result: { text: report },
            };
          if (method === "repo.task.dispatches")
            return { dispatches: [{ dispatchId, fallbackState: null, nextDispatchId: null }] };
          if (method === "repo.vertical.declaration.read") return { declaration: vertical };
          if (method === "repo.settings.read")
            return { settings: { decisions: { provider: providerId, enabledPoints: [binding] } } };
          throw new Error(`Unexpected fixture read ${method}.`);
        },
      } as unknown as RepoCell,
      providerStates: string[] = [];
    const executor = openDecisionPointExecutor({
      rootDir,
      providers: {
        list: providers.list,
        port: {
          decide: async (request) => {
            providerStates.push(request.state[0]);
            return providers.port.decide(request);
          },
        },
      },
      now: () => new Date().toISOString(),
    });
    const startedAt = Date.now();
    await executor.settle(cell, outcome);
    const elapsedMs = Date.now() - startedAt,
      entries = await openDecisionAnnotationStore(rootDir).export(),
      annotation = entries[0];
    assert.equal(entries.length, 1);
    assert.equal(annotation?.status, "succeeded");
    assert.ok(annotation.advisory && annotation.egress);
    assert.equal(annotation.pointId, pointId);
    assert.equal(annotation.event, "dispatch.settled");
    assert.match(
      providerStates[0] ?? "",
      /report: Worker stopped after the package registry rejected a publish request\./u,
    );
    assert.deepEqual(annotation.egress.fields, ["dispatch.reason", "dispatch.classification", "report.body"]);
    assert.equal(annotation.egress.providerId, providerId);
    assert.equal(annotation.egress.model, model);
    assert.match(annotation.egress.inputDigest, /^[0-9a-f]{64}$/u);
    console.log(
      `decision-settled-smoke ${JSON.stringify({
        event: annotation.event,
        pointId: annotation.pointId,
        selected: annotation.advisory.selected,
        distribution: annotation.advisory.distribution,
        providerLatencyMs: annotation.advisory.latencyMs,
        endToEndElapsedMs: elapsedMs,
        egressReceipt: annotation.egress,
        providerState: providerStates[0],
      })}`,
    );
  },
);
