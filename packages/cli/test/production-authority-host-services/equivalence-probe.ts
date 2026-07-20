import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface ProbeHostServices {
  readonly productionAuthorityIngressFor: (kind: string) => unknown;
  readonly normalizeDecisionProposeAction: (action: any) => any;
  readonly materializeProposedDecision: (action: any) => unknown;
  readonly renderForceStatusAudit: (status: string, reason: string, recordedAt?: string) => string;
  readonly buildTaskCreateWrites: (input: any) => unknown;
  readonly loadDaemonIdentity: (
    rootDir: string,
    layoutOverrides: { readonly authoredRoot?: string } | undefined,
    endpoint?: string,
    userRoot?: string
  ) => unknown;
}

const fixedAt = "2026-07-20T00:00:00.000Z";
const provenance = { runtime: "codex", sessionId: "session-golden", boundAt: fixedAt } as const;

export function captureProductionAuthorityHostEquivalence(host: ProbeHostServices): unknown {
  const root = mkdtempSync(path.join(tmpdir(), "ha-batch5a-host-probe-"));
  const missingRoot = path.join(root, "missing");
  const settingsRoot = path.join(root, "settings");
  const invalidSettingsRoot = path.join(root, "invalid-settings");
  const identityRoot = path.join(root, "identity");
  const invalidIdentityRoot = path.join(root, "invalid-identity");
  mkdirSync(path.join(settingsRoot, "harness"), { recursive: true });
  mkdirSync(path.join(invalidSettingsRoot, "harness"), { recursive: true });
  mkdirSync(path.join(identityRoot, "harness"), { recursive: true });
  mkdirSync(path.join(invalidIdentityRoot, "harness"), { recursive: true });
  writeFileSync(path.join(settingsRoot, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "project: golden",
    "settings:",
    "  defaultVertical: software/coding",
    "  defaultPreset: standard-task",
    "  locale: en-US",
    ""
  ].join("\n"));
  writeFileSync(path.join(invalidSettingsRoot, "harness/harness.yaml"), "{\n");
  writeFileSync(path.join(identityRoot, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "project: golden",
    "settings:",
    "  identity:",
    "    personId: person_golden",
    "    displayName: Golden Person",
    ""
  ].join("\n"));
  writeFileSync(path.join(invalidIdentityRoot, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "project: golden-remote",
    "settings:",
    "  identity:",
    "    mode: remote",
    ""
  ].join("\n"));

  const decisionBase = {
    kind: "decision-propose",
    decisionId: "dec_GOLDEN",
    proposedAt: fixedAt,
    title: "Golden decision",
    question: "Keep bytes?",
    chosen: [{ text: "Yes" }],
    rejected: [{ text: "No", why_not: "Breaks parity" }],
    claim: "Bytes stay stable",
    claims: [],
    claimLoadBearing: true,
    fulfillments: [],
    riskTier: "medium",
    urgency: "high",
    modules: [],
    productLines: [],
    evidenceRelations: [],
    dryRun: false
  };
  const normalizedExplicit = host.normalizeDecisionProposeAction({
    ...decisionBase,
    chosen: [{ id: "CH9", text: "Yes" }],
    rejected: [{ id: "RJ9", text: "No", why_not: "Breaks parity" }],
    claims: [{ id: "C9", text: "Bytes stay stable" }]
  });
  const normalizedDefaults = host.normalizeDecisionProposeAction(decisionBase);
  const normalizedDuplicateRecovery = host.normalizeDecisionProposeAction({
    ...decisionBase,
    chosen: [{ id: "CH1", text: "One" }, { id: "CH1", text: "Two" }]
  });

  const taskAction = {
    kind: "new-task",
    taskId: "task_GOLDEN",
    title: "Golden task",
    slug: "golden-task",
    allowManualId: false,
    longRunning: false,
    dryRun: false
  };
  const priorEmail = process.env.HARNESS_GIT_AUTHOR_EMAIL;
  process.env.HARNESS_GIT_AUTHOR_EMAIL = "golden@example.test";
  try {
    return {
      ingressAdapters: {
        generic: host.productionAuthorityIngressFor("new-task"),
        decisionTransition: host.productionAuthorityIngressFor("decision-transition"),
        taskClaim: host.productionAuthorityIngressFor("task-claim"),
        observedWrite: host.productionAuthorityIngressFor("task-amend")
      },
      normalizer: {
        success: normalizedExplicit,
        defaults: normalizedDefaults,
        duplicateRecovery: normalizedDuplicateRecovery
      },
      materializer: {
        success: capture(() => host.materializeProposedDecision(normalizedExplicit)),
        defaults: capture(() => host.materializeProposedDecision(normalizedDefaults)),
        failure: capture(() => host.materializeProposedDecision({
          ...normalizedExplicit,
          evidenceRelations: [{ anchor: "MISSING", type: "supports", target: "task/task_GOLDEN", rationale: "invalid" }]
        }))
      },
      identity: {
        success: capture(() => identitySummary(host.loadDaemonIdentity(identityRoot, undefined))),
        defaults: capture(() => identitySummary(host.loadDaemonIdentity(missingRoot, undefined))),
        failure: capture(() => identitySummary(host.loadDaemonIdentity(invalidIdentityRoot, undefined)))
      },
      forceStatusAudit: {
        success: host.renderForceStatusAudit("completed", "golden reason", fixedAt),
        defaults: normalizeGeneratedTimestamp(host.renderForceStatusAudit("in_review", "default timestamp")),
        edge: host.renderForceStatusAudit("", "", fixedAt)
      },
      taskCreateWrites: {
        adapterDefault: byteEvidence(capture(() => host.buildTaskCreateWrites({
          rootInput: { rootDir: missingRoot }, action: taskAction, createdAt: fixedAt, provenance
        }))),
        settingsPreset: byteEvidence(capture(() => host.buildTaskCreateWrites({
          rootInput: { rootDir: settingsRoot }, action: taskAction, createdAt: fixedAt, provenance
        }))),
        settingsFailure: byteEvidence(capture(() => host.buildTaskCreateWrites({
          rootInput: { rootDir: invalidSettingsRoot }, action: taskAction, createdAt: fixedAt, provenance
        })))
      }
    };
  } finally {
    if (priorEmail === undefined) delete process.env.HARNESS_GIT_AUTHOR_EMAIL;
    else process.env.HARNESS_GIT_AUTHOR_EMAIL = priorEmail;
    rmSync(root, { recursive: true, force: true });
  }
}

function capture(run: () => unknown): unknown {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}:${error.message}` : String(error) };
  }
}

function identitySummary(value: unknown): unknown {
  const identity = value as {
    readonly mode?: unknown;
    readonly personRegistry?: { readonly people?: ReadonlyArray<{ readonly personId?: unknown }> };
    readonly identityProvider?: { readonly providerId?: unknown };
    readonly identityAdminSnapshot?: { readonly people?: ReadonlyArray<{ readonly personId?: unknown; readonly primaryEmail?: unknown }> };
  };
  return {
    mode: identity.mode,
    people: identity.personRegistry?.people?.map((person) => person.personId) ?? [],
    providerId: identity.identityProvider?.providerId ?? null,
    adminPeople: identity.identityAdminSnapshot?.people?.map((person) => ({
      personId: person.personId,
      primaryEmail: person.primaryEmail
    })) ?? []
  };
}

function normalizeGeneratedTimestamp(value: string): string {
  return value.replace(/recordedAt=[^;\s]+/u, "recordedAt=<generated-at>");
}

function byteEvidence(value: unknown): { readonly byteLength: number; readonly sha256: string } {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
import { createHash } from "node:crypto";
