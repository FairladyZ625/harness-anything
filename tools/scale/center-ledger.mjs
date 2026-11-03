import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileTaskBootstrap } from "../../packages/preset/src/preset-bootstrap.ts";
import { canonicalDocumentClaims } from "../../packages/kernel/src/ports/canonical-document-claims.ts";
import { serializePersistedCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { canonicalLedgerCut } from "../../packages/kernel/src/ports/canonical-event-store.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../packages/kernel/src/domain/artifact-text-classification.ts";
import { openSqliteEventStore } from "../../packages/storage/src/store/sqlite-event-store.ts";
import { docBundle, initRepo } from "../../packages/storage/test/store/task-event-store.fixtures.ts";

export const canonicalShape = Object.freeze({
  events: 225_000,
  documents: 135_000,
  tasks: 5000,
  jsonBytes: 1_900_000_000,
  largeJsonBytes: [10, 50, 286].map((mb) => mb * 1_000_000),
});
const digest = (body) => createHash("sha256").update(body).digest("hex");

export async function initializeSyntheticLedger(rootDir, { scale = 1, seed = "20261103" } = {}) {
  const { seedSettingsEvent } = await import("../../packages/daemon/test/repo-settings.fixture.ts");
  mkdirSync(rootDir);
  initRepo(rootDir);
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nname: center-bench\n");
  const seeded = seedSettingsEvent({ rootDir, repoId: "center-bench", keepOpen: true });
  await seeded.drain();
  return generateCenterLedger({
    rootDir,
    repoId: "center-bench",
    userRoot: path.join(rootDir, ".harness", "bench-user"),
    seed,
    profile: ledgerProfile(scale),
  });
}

// Random-looking ASCII, bounded to one document. Seed and index determine bytes independently of batching.
export function syntheticJson(seed, index, bytes) {
  const prefix = `{"synthetic":true,"index":${index},"data":"`,
    suffix = '"}\n';
  const length = Math.max(0, bytes - Buffer.byteLength(prefix + suffix));
  let state = createHash("sha256").update(`${seed}:${index}`).digest().readUInt32LE(0) || 1;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const buffer = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length; offset++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[offset] = alphabet.charCodeAt((state >>> 0) & 63);
  }
  return prefix + buffer.toString("ascii") + suffix;
}

export function ledgerProfile(scale = 1) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new Error("scale must be >0 and <=10");
  return {
    events: Math.max(2, Math.round(canonicalShape.events * scale)),
    documents: Math.max(1, Math.round(canonicalShape.documents * scale)),
    tasks: Math.max(1, Math.round(canonicalShape.tasks * scale)),
    jsonBytes: Math.round(canonicalShape.jsonBytes * scale),
    largeJsonBytes: Array.from({ length: Math.ceil(scale) }, () =>
      canonicalShape.largeJsonBytes.map((bytes) => Math.round(bytes * Math.min(scale, 1))),
    ).flat(),
  };
}

/** Offline fixture construction only. The caller initializes an empty synthetic repository first.
 * Production appendCommand validates canonical events and content; no SQL schema is mirrored here.
 * A command batches <=256 events to avoid per-event Git/CLI process overhead during fixture setup.
 */
export async function generateCenterLedger({
  rootDir,
  repoId,
  userRoot,
  seed = "20261103",
  profile = ledgerProfile(),
  onProgress = () => undefined,
}) {
  const store = openSqliteEventStore({ rootInput: rootDir, repoId });
  const baseline = store.revision(),
    fence = { repoId, holder: "center-bench-generator", epoch: (store.writerFence()?.epoch ?? 0) + 1 };
  store.claimWriter(fence);
  const originalHead = baseline ? store.eventAtRevision(baseline) : null;
  let cut = canonicalLedgerCut(
    repoId,
    originalHead
      ? {
          revision: baseline,
          opId: originalHead.opId,
          eventDigest: `sha256:${digest(serializePersistedCanonicalEvent(originalHead))}`,
        }
      : null,
  );
  const paths = new Set(),
    types = {},
    sampleTasks = [],
    sampleDocuments = [];
  let events = [],
    blobs = [],
    eventJsonBytes = 0,
    contentJsonBytes = 0,
    generated = 0,
    documents = 0;
  const started = performance.now();
  const flush = () => {
    if (!events.length) return;
    const opId = events.at(-1).opId;
    const result = store.appendCommand({
      fence,
      intent: { opId, intentDigest: digest(opId), summary: "synthetic center ledger" },
      events,
      blobs,
    });
    if (result.status !== "accepted_durable") throw new Error(`fixture append failed: ${JSON.stringify(result)}`);
    const last = events.at(-1);
    cut = canonicalLedgerCut(repoId, {
      revision: last.workspaceRevision,
      opId: last.opId,
      eventDigest: `sha256:${digest(serializePersistedCanonicalEvent(last))}`,
    });
    events = [];
    blobs = [];
  };
  const accept = (bundle) => {
    events.push(bundle.event);
    blobs.push(...bundle.blobs);
    eventJsonBytes += Buffer.byteLength(serializePersistedCanonicalEvent(bundle.event));
    for (const claim of canonicalDocumentClaims(bundle.event)) paths.add(claim.path);
    for (const blob of bundle.blobs) contentJsonBytes += blob.size;
    types[bundle.event.type] = (types[bundle.event.type] ?? 0) + 1;
    generated++;
    if (events.length === 256) flush();
  };
  const actor = { principal: { personId: "center-bench" }, executor: { kind: "agent", id: "center-bench" } };
  try {
    for (let index = 0; index < profile.tasks; index++) {
      const revision = baseline + generated + 1,
        taskId = `task_${digest(`${seed}:${index}`).slice(0, 26)}`;
      accept(
        compileTaskBootstrap({
          taskId,
          title: `Synthetic task ${index}`,
          presetId: "standard-task",
          verticalId: "software/coding",
          locale: "en-US",
          workKind: "test",
          riskTier: "low",
          urgency: "low",
          userRoot,
          actor,
          source: "local",
          eventId: `event-center-${seed}-${revision}`,
          opId: `op-center-${seed}-${revision}`,
          workspaceRevision: revision,
          occurredAt: new Date(Date.UTC(2026, 0, 1) + revision * 1000).toISOString(),
        }),
      );
      if (sampleTasks.length < 20) sampleTasks.push(taskId);
    }
    flush();
    const bootstrapDocuments = paths.size,
      needed = profile.documents - bootstrapDocuments;
    if (needed < 1 || needed > profile.events - generated)
      throw new Error("profile needs room for task documents and document events");
    const large = profile.largeJsonBytes.slice(0, needed),
      largeTotal = large.reduce((sum, n) => sum + n, 0);
    // The 225-event calibration measured about 0.8 KB per document event. Emit the actual deviation too.
    const smallBytes = Math.max(
      128,
      Math.floor(
        (profile.jsonBytes - contentJsonBytes - eventJsonBytes - (profile.events - generated) * 800 - largeTotal) /
          Math.max(1, needed - large.length),
      ),
    );
    while (generated < profile.events) {
      const revision = baseline + generated + 1,
        index = documents % needed;
      const logical = `context/center-bench/doc-${index}.json`;
      // Rewrites retain deterministic content and reuse objects. They supply event density after every document exists.
      const size = large[index] ?? smallBytes,
        body = syntheticJson(seed, index, size);
      const bundle = docBundle({ currentCut: () => cut }, body, revision, `op-center-${seed}-${revision}`, logical);
      bundle.event.occurredAt = new Date(Date.UTC(2026, 0, 1) + revision * 1000).toISOString();
      bundle.event.payload.changes[0].candidate.mediaType = "application/json";
      bundle.event.payload.changes[0].policyId = OPAQUE_TEXTUAL_POLICY_ID;
      bundle.event.payload.changes[0].regionProofs = [];
      bundle.blobs[0].mediaType = "application/json";
      const previous = store.documentHead(logical);
      bundle.event.payload.changes[0].baseBlobSha256 = previous && previous !== "retired" ? previous.sha256 : null;
      if (documents >= needed) bundle.blobs = [];
      accept(bundle);
      if (documents < needed && sampleDocuments.length < 20)
        sampleDocuments.push({ path: logical, size, sha256: digest(body) });
      documents++;
      // Large objects never accumulate in the batch.
      if (size >= 1_000_000) flush();
      if (generated % 10_000 === 0) {
        flush();
        onProgress({ generated, documents: paths.size, elapsedMs: performance.now() - started });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    flush();
    const result = {
      schema: "center-ledger/v1",
      seed,
      profile,
      baselineRevision: baseline,
      revision: store.revision(),
      generatedEvents: generated,
      documents: paths.size,
      tasks: profile.tasks,
      eventTypes: types,
      eventJsonBytes,
      contentJsonBytes,
      jsonBytes: eventJsonBytes + contentJsonBytes,
      largeJsonBytes: large,
      sampleTasks,
      sampleDocuments,
      position: store.replicationPosition(),
      deviation: {
        events: generated - profile.events,
        documents: paths.size - profile.documents,
        jsonBytesRatio: (eventJsonBytes + contentJsonBytes) / profile.jsonBytes,
      },
      limitations: [
        "Task bootstrap uses the production preset compiler; remaining activity is documents_written.",
        "Document rewrites repeat content: event density matches; historical object churn does not.",
        "JSON byte count covers generated event serialization and newly supplied content, excluding fixture settings.",
      ],
    };
    mkdirSync(path.join(rootDir, ".harness"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness", "center-bench-ledger.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    store.releaseWriter(fence);
    store.close();
  }
}
