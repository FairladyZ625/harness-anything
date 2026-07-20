// harness-test-tier: nightly
// harness-test-tier-decision: dec_01KXZ2WZMB8YS18F549K8BMM7H
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import {
  decodeSemanticMutationEnvelopeV2,
  decodeSessionExecutionReviewCommandPayloadV2,
  decodeTaskDecisionModuleCommandPayloadV2
} from "@harness-anything/application";
import { channelDigest32, connectionGeneration } from "@harness-anything/daemon";
import type { ParsedCommand } from "../../src/cli/types.ts";
import { defaultCliAdapterProvider } from "../../src/composition/adapter-registry.ts";
import { createCliProductionAuthorityLifecycle } from "../../src/composition/production-authority-lifecycle.ts";
import { createDaemonCommandService } from "@harness-anything/daemon";
import { cliDaemonCommandHostServices } from "../../src/composition/daemon-command-host-services.ts";
import { authorityOperationShape } from "../production-authority-canonical-ingress/operation-shape.ts";
import {
  createFixture,
  latestAuthorityOperation
} from "../production-authority-canonical-ingress/fixture.ts";

const fixtureUrl = new URL("./fixtures/batch5a-parent-differential.json", import.meta.url);
const createCliCommandService = (
  runtime: Parameters<typeof createDaemonCommandService>[0],
  options: Parameters<typeof createDaemonCommandService>[2] = {}
) => createDaemonCommandService(runtime, cliDaemonCommandHostServices, options);

test("all four production ingress adapters retain canonical envelope and receipt bytes", { timeout: 120_000 }, async () => {
  const fixture = createFixture();
  const daemon = defaultCliAdapterProvider().createMultiRepoDaemonRuntime({
    repos: [{ repoId: "canonical", rootDir: fixture.repoRoot }],
    materializerPollMs: 5,
    materializerMaxBranchesPerBatch: 1
  });
  const lifecycle = createCliProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
  try {
    await daemon.start();
    const runtime = daemon.getRepoRuntime("canonical");
    assert.ok(runtime);
    const started = await lifecycle.startRepo({ repoId: "canonical", canonicalRoot: fixture.repoRoot }, runtime);
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const submission = started.component.bindConnection({
      schema: "authority-connection-context/v1",
      connectionId: "batch5a-adapter-golden",
      connectionGeneration: connectionGeneration("batch5a-adapter-golden"),
      actor: fixture.actor,
      repoId: "canonical",
      channelBinding: { digest: channelDigest32(Buffer.alloc(32, 0x51)), source: "transport-observed" },
      peerCredential: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }
    });
    const service = createCliCommandService(runtime, { resolveAuthoritySubmissionV2: () => submission });
    let sequence = 0;
    const run = async (action: ParsedCommand["action"], executor: { readonly kind: "agent"; readonly id: string } | null = { kind: "agent", id: "codex" }) => service.runCommand({
      command: { rootDir: fixture.repoRoot, json: true, action },
      session: {
        runtime: "codex",
        sessionId: `batch5a-adapter-${++sequence}`,
        source: "manual",
        detectedAt: "2026-07-20T00:00:00.000Z"
      }
    }, {
      actor: { ...fixture.actor, roles: ["owner"] },
      executor
    });
    const capture = async (action: ParsedCommand["action"], executor?: { readonly kind: "agent"; readonly id: string } | null) => {
      const receipt = await run(action, executor === undefined ? { kind: "agent", id: "codex" } : executor);
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      const operation = latestAuthorityOperation(fixture.serviceRoot);
      assert.ok(operation.canonicalRequestEnvelope);
      const envelope = decodeSemanticMutationEnvelopeV2(
        Buffer.from(operation.canonicalRequestEnvelope, "base64url")
      );
      const envelopeShape = canonicalEnvelopeShape(envelope);
      if (process.env.HARNESS_DEBUG_BATCH5A_ENVELOPE === "1") {
        process.stdout.write(`BATCH5A_ENVELOPE_SHAPE:${JSON.stringify(envelopeShape, bigintReplacer)}\n`);
      }
      return {
        envelope: byteEvidence(envelopeShape),
        receipt: byteEvidence(adapterGoldenShape(authorityOperationShape(receipt)))
      };
    };

    const actual = {
      generic: await capture({
        kind: "progress-append",
        taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0",
        text: "batch 5A generic adapter golden",
        dryRun: false
      }),
      taskClaim: await capture({
        kind: "task-claim",
        taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
        execution: true
      }),
      observedWrite: await capture({
        kind: "task-amend",
        taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK0",
        patches: [{ field: "taskClass", value: "milestone" }]
      })
    } as Record<string, unknown>;
    await run({
      kind: "decision-propose",
      decisionId: "dec_BATCH5A_GOLDEN",
      proposedAt: "2026-07-20T00:00:00.000Z",
      title: "Batch 5A adapter golden",
      question: "Do adapter bytes remain stable?",
      chosen: [{ text: "Yes" }],
      rejected: [{ text: "No", why_not: "That would violate the migration invariant" }],
      claims: [{ text: "The adapter bytes remain stable" }],
      claimLoadBearing: false,
      fulfillments: [],
      riskTier: "medium",
      urgency: "medium",
      modules: [],
      productLines: [],
      evidenceRelations: [],
      dryRun: false
    });
    actual.decisionTransition = await capture({
      kind: "decision-transition",
      transition: "accept",
      decisionId: "dec_BATCH5A_GOLDEN",
      judgmentOnlyRationale: "Golden transition uses explicit human judgment.",
      fulfillments: [],
      dryRun: false
    }, null);

    if (process.env.HARNESS_CAPTURE_BATCH5A_GOLDEN === "1") {
      process.stdout.write(`BATCH5A_ADAPTER_GOLDEN_START\n${JSON.stringify(actual, null, 2)}\nBATCH5A_ADAPTER_GOLDEN_END\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(fixtureUrl, "utf8")) as { readonly adapterE2E: unknown };
    assert.equal(JSON.stringify(actual), JSON.stringify(baseline.adapterE2E));
  } finally {
    await lifecycle.stopAll("daemon-shutdown").catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    if (process.env.KEEP_AUTHORITY_SERVICE_FIXTURE !== "1") rmSync(fixture.root, { recursive: true, force: true });
  }
});

function canonicalEnvelopeShape(envelope: ReturnType<typeof decodeSemanticMutationEnvelopeV2>): unknown {
  const commandName = envelope.intent.kind === "typed" ? envelope.intent.command.name : "";
  const payload = commandName === "execution.claim"
    ? decodeSessionExecutionReviewCommandPayloadV2(envelope).payload
    : decodeTaskDecisionModuleCommandPayloadV2(envelope).payload;
  return adapterGoldenShape(authorityOperationShape({
    schema: envelope.schema,
    workspaceId: envelope.workspaceId,
    schemaTuple: envelope.schemaTuple,
    binding: {
      deviceId: envelope.binding.deviceId,
      viewId: envelope.binding.viewId,
      sessionId: "<SESSION_ID>"
    },
    intent: envelope.intent.kind === "typed" ? {
      kind: envelope.intent.kind,
      command: envelope.intent.command,
      canonicalPayload: payload,
      baseCas: envelope.intent.baseCas,
      declaredPathCas: envelope.intent.declaredPathCas
    } : envelope.intent,
    claimedMutationSet: envelope.claimedMutationSet
  }));
}

function adapterGoldenShape(value: unknown, key = ""): unknown {
  if (key === "leaseToken") return "<LEASE_TOKEN>";
  if (key === "_coordinatorWatermark") return "<OP_ID>";
  if (key === "digest" && typeof value === "string" && value.startsWith("sha256:")) return "<DIGEST>";
  if (key === "expectedEpoch") return "<EPOCH>";
  if (Array.isArray(value)) return value.map((entry) => adapterGoldenShape(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entry]) => [entryKey, adapterGoldenShape(entry, entryKey)]));
  }
  return value;
}

function byteEvidence(value: unknown): { readonly byteLength: number; readonly sha256: string } {
  const bytes = Buffer.from(JSON.stringify(value, bigintReplacer));
  return { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function bigintReplacer(_key: string, entry: unknown): unknown {
  return typeof entry === "bigint"
    ? entry.toString()
    : entry instanceof Uint8Array
      ? Buffer.from(entry).toString("base64url")
      : entry;
}
