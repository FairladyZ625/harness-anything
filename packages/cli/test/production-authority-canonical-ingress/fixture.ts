import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { createAuthorityKeyRegistryV1, firstPinAuthorityKeyV1 } from "../../../application/src/index.ts";
import { openLocalAuthorityKeyStore } from "../../../daemon/src/index.ts";
import { executionDeclaration, type ExecutionRecord } from "../../../kernel/src/index.ts";
import { authorityNamespaceProofBytes } from "../../src/daemon/authority-production-state.ts";

export function createFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-production-canonical-ingress-")));
  const repoRoot = path.join(root, "repo");
  const authoredRoot = path.join(repoRoot, "harness");
  const auxiliaryRoot = path.join(root, "auxiliary");
  const auxiliaryAuthoredRoot = path.join(auxiliaryRoot, "harness");
  const serviceRoot = path.join(root, "service-state");
  const keyStateDirectory = path.join(serviceRoot, "keys/canonical");
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"), { recursive: true });
  mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(authoredRoot, "harness.yaml"), "schema: harness-anything/v1\nproject: production-ingress\n");
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/INDEX.md"), taskIndexBody("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"));
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/closeout.md"), "# Closeout\n\nProduction fixture qualified.\n");
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"), taskIndexBody("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"));
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8-production-route"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8-production-route/INDEX.md"), taskIndexBody("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8"));
  const actor = {
    personId: "person_alice", displayName: "Alice", primaryEmail: "alice@example.test", providerId: "transport-derived/v1",
    resolvedCredential: { kind: "unix-socket-owner-boundary" as const, issuer: `host:${hostname()}`, subject: String(process.getuid?.() ?? 0) }
  };
  const submittedExecution: ExecutionRecord = {
    schema: "execution/v2", execution_id: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", task_ref: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", state: "submitted",
    primary_actor: { principal: { personId: "person_alice" }, executor: { kind: "agent", id: "codex" }, responsibleHuman: "person_alice" },
    claimed_at: "2026-07-17T00:00:00.000Z", submitted_at: "2026-07-17T00:01:00.000Z", closed_at: null,
    session_bindings: [], outputs: [{ evidence_id: "evidence:ingress", execution_ref: "execution/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", locator: { substrate: "inline", text: "passed" } }],
    submission: { completion_claim: "Ingress qualified", deliverables: ["journal"], evidence_refs: ["evidence:ingress"], verification_notes: ["integration"], known_gaps: [], residual_risks: [] }
  };
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5.md"), executionDeclaration.documentCodec.encode(submittedExecution));
  const transcriptPath = path.join(root, "session-transcript.md");
  writeFileSync(transcriptPath, `${JSON.stringify({ timestamp: "2026-07-17T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Production session ingress." } })}\n`);
  writeFileSync(path.join(authoredRoot, "people.yaml"), [
    "schema: harness-people/v1", "people:", "  - personId: person_alice", "    displayName: Alice",
    "    primaryEmail: alice@example.test", "    roles: [owner]", "    credentials:",
    "      - kind: unix-socket-owner-boundary", `        issuer: host:${hostname()}`, `        subject: ${process.getuid?.() ?? 0}`,
    "roles:", "  - roleId: owner", "    commandClasses: [admin, repo-write, repo-read, arbiter]", ""
  ].join("\n"));
  const keyStore = openLocalAuthorityKeyStore({ serviceStateRoot: serviceRoot, stateDirectory: keyStateDirectory, workspaceRoot: repoRoot, authorityId: "authority.production", issuer: "authority.production" });
  const now = Date.now();
  const prepublished = keyStore.createPrepublishedKey({ generation: 1, nowMs: now - 1_000 });
  const registry = firstPinAuthorityKeyV1({
    registry: createAuthorityKeyRegistryV1({ authorityId: "authority.production", generation: 1, globalRevocationEpoch: 1, revision: 1, entries: [prepublished] }),
    keyId: prepublished.keyId, expectedPinnedKeyId: prepublished.keyId, pinEvidence: "fixture-out-of-band-pin",
    verifierAcknowledgement: "fixture-verifier-ack", activatedAtMs: now - 999
  });
  const registryPath = path.join(authoredRoot, "authority-key-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const unsignedNamespace = {
    schema: "operation-namespace/v1" as const, workspaceId: "workspace-production", deviceId: "device-production",
    authorityGeneration: 1n, namespaceId: "namespace-production", expiresAt: BigInt(now + 60 * 60_000),
    issuer: "authority.production", keyId: prepublished.keyId
  };
  const proof = sign(null, authorityNamespaceProofBytes(unsignedNamespace), keyStore.signingProfile(registry, now).privateKey);
  const manifestPath = path.join(serviceRoot, "authority-production.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "authority-production-composition/v1", serviceStateRoot: serviceRoot, repos: [{
      repoId: "canonical", canonicalRoot: repoRoot, workspaceId: "workspace-production", deviceId: "device-production",
      viewId: "view-production", sessionId: "session-production", authorityId: "authority.production", issuer: "authority.production",
      keyRegistryPath: registryPath, keyStateDirectory, schemaTuple: productionTuple(), authorityGeneration: 1,
      revocationEpochs: { global: "1", workspace: "1", device: "1", view: "1", principal: "1", executor: "1" },
      admissionTokenRef: "admission-production", allowedExecutorAgentIds: ["codex"],
      operationNamespace: { ...unsignedNamespace, authorityGeneration: "1", expiresAt: unsignedNamespace.expiresAt.toString(), proof: proof.toString("base64url") }
    }]
  }, null, 2)}\n`);
  writeFileSync(path.join(repoRoot, "README.md"), "# Distinct public repository\n");
  git(repoRoot, "init", "-q"); git(repoRoot, "add", "README.md"); git(repoRoot, "commit", "-q", "-m", "seed distinct public fixture");
  const publicHead = git(repoRoot, "rev-parse", "HEAD");
  git(authoredRoot, "init", "-q"); git(authoredRoot, "add", "."); git(authoredRoot, "commit", "-q", "-m", "seed canonical ingress fixture");
  mkdirSync(auxiliaryAuthoredRoot, { recursive: true });
  writeFileSync(path.join(auxiliaryAuthoredRoot, "harness.yaml"), "schema: harness-anything/v1\nproject: auxiliary-ingress\n");
  git(auxiliaryAuthoredRoot, "init", "-q"); git(auxiliaryAuthoredRoot, "add", "."); git(auxiliaryAuthoredRoot, "commit", "-q", "-m", "seed auxiliary ingress fixture");
  return { root, repoRoot, authoredRoot, auxiliaryRoot, serviceRoot, manifestPath, actor, transcriptPath, publicHead };
}

export function enablePresetAwareTaskCreate(authoredRoot: string): void {
  writeFileSync(path.join(authoredRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "project: production-ingress",
    "settings:",
    "  defaultVertical: software/coding",
    "  defaultPreset: docs-task",
    "  locale: en-US",
    ""
  ].join("\n"));
  git(authoredRoot, "add", "harness.yaml");
  git(authoredRoot, "commit", "-q", "-m", "configure preset-aware task create fixture");
}

export function writeColdCodexSessionLog(repoRoot: string, sessionId: string): void {
  const logRoot = path.join(repoRoot, ".home", ".codex", "sessions", "2026", "07", "18");
  mkdirSync(logRoot, { recursive: true });
  writeFileSync(path.join(logRoot, `rollout-2026-07-18T00-00-00-${sessionId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-07-18T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: `Cold production session ${sessionId}.` }
  })}\n`);
}

export function latestAuthorityOperation(serviceRoot: string): { readonly state?: string; readonly opId?: string; readonly commitSha?: string; readonly receipt?: { readonly tag?: string } } {
  const rows = readFileSync(operationPath(serviceRoot), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { readonly table?: string; readonly value?: Record<string, unknown> })
    .filter((row) => row.table === "operation" && row.value);
  assert.ok(rows.length > 0, "service route must persist an authority operation");
  return rows.at(-1)!.value as ReturnType<typeof latestAuthorityOperation>;
}

export function authorityOperationRecords(serviceRoot: string): ReadonlyArray<{ readonly state?: string; readonly opId?: string }> {
  const latest = new Map<string, { readonly state?: string; readonly opId?: string }>();
  for (const line of readFileSync(operationPath(serviceRoot), "utf8").trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as { readonly table?: string; readonly key?: string; readonly value?: { readonly state?: string; readonly opId?: string } };
    if (row.table === "operation" && row.key && row.value) latest.set(row.key, row.value);
  }
  return [...latest.values()];
}

export function authorityEventBodies(authoredRoot: string): ReadonlyArray<string> {
  const eventRoot = path.join(authoredRoot, "authority-attribution-events/v2");
  if (!existsSync(eventRoot)) return [];
  return execFileSync("find", [eventRoot, "-type", "f"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    .map((eventPath) => readFileSync(eventPath, "utf8"));
}

export function indeterminateWithoutPublication() {
  return {
    workspaceId: "workspace-production", opId: "namespace-production:unpublished-startup", semanticDigest: "a".repeat(64), state: "INDETERMINATE" as const,
    receipt: { tag: "INDETERMINATE" as const, workspaceId: "workspace-production", opId: "namespace-production:unpublished-startup", semanticDigest: "a".repeat(64), reason: "PUBLICATION_OUTCOME_UNKNOWN:startup performance fixture" },
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2" as const, semanticRequestDigest: "a".repeat(64), semanticMutationSetDigest: "c".repeat(64), mutationRegistryVersion: 1,
      actorAxesBindingDigest: "d".repeat(64), canonicalMutationSet: { registryVersion: 1, mutations: [{ entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4" }, action: { registryVersion: 1, action: "append" } }] }
    },
    recordedProtocol: { kind: "semantic-mutation-envelope/v2" as const, schemaTuple: productionTuple() }, canonicalRequestEnvelope: "startup-performance-envelope"
  };
}

export function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "ZeyuLi", GIT_AUTHOR_EMAIL: "33339424+FairladyZ625@users.noreply.github.com", GIT_COMMITTER_NAME: "ZeyuLi", GIT_COMMITTER_EMAIL: "33339424+FairladyZ625@users.noreply.github.com" }
  }).trim();
}

export function prepareLongHistoryFixture(authoredRoot: string): void {
  git(authoredRoot, "config", "--local", "gc.auto", "0");
  git(authoredRoot, "config", "--local", "maintenance.auto", "false");
}

export function sealLongHistoryFixture(authoredRoot: string): string {
  git(authoredRoot, "repack", "-a", "-d");
  git(authoredRoot, "fsck", "--full", "--strict");
  const head = git(authoredRoot, "rev-parse", "HEAD");
  const commits = git(authoredRoot, "rev-list", "--first-parent", head).split("\n").filter(Boolean);
  assert.ok(commits.length > 0, "sealed fixture history must contain a readable first-parent chain");
  assert.equal(commits[0], head, "sealed fixture history must start at the observed HEAD");
  return head;
}

function operationPath(serviceRoot: string): string {
  return path.join(serviceRoot, "authority", Buffer.from("canonical", "utf8").toString("base64url"), "operations.jsonl");
}

function taskIndexBody(taskId: string): string {
  return ["---", "schema: task-package/v2", `task_id: ${taskId}`, "title: Production ingress", "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: active", "  ref: ", "  titleSnapshot: Production ingress", "  url: ", "  bindingCreatedAt: 2026-07-17T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`, "packageDisposition: active", "vertical: default", "preset: default", "provenance:", "  - {runtime: \"human\", sessionId: \"fixture\", boundAt: \"2026-07-17T00:00:00.000Z\"}", "---", "", "# Production ingress", ""].join("\n");
}

function productionTuple() {
  return { wire: 2, event: 2, receipt: 2, digest: 2, policy: 2, commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1 } as const;
}
