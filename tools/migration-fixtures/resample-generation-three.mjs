#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializeCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync-canonical-events.ts";
import { submissionDigest } from "../../packages/kernel/src/domain/execution.ts";
import { reviewDigest } from "../../packages/kernel/src/domain/review.ts";
import { GenerationThreeMigration } from "../../packages/kernel/src/store/generation-three-migration.ts";

const root = "packages/kernel/fixtures/canonical-events/task-event-v1";

// Mirrors GenerationThreeMigration.#completionContract: only the internal code-doc checker
// keeps an adapter requirement; every other declared gate becomes read-only preserved history.
function completionContract(gateIds) {
  return {
    gates: [...new Set(gateIds)].map((gateId) =>
      gateId === "code-doc-reconciliation"
        ? {
            gateId,
            appliesTo: "code",
            witness: { kind: "adapter", adapterId: "code-doc-reconciliation", adapterOptions: {} },
          }
        : {
            gateId,
            appliesTo: "code",
            witness: { kind: "historical-policy-unavailable", reason: "not-recorded" },
          },
    ),
  };
}

for (const name of readdirSync(root).filter((candidate) => candidate.endsWith(".json"))) {
  const file = path.join(root, name),
    event = JSON.parse(readFileSync(file, "utf8")),
    execution = event.payload?.execution;
  if (!execution?.submission) continue;
  const submission = {
      ...execution.submission,
      completionContract: completionContract(event.payload.task.completionGateIds),
    },
    payload = { ...event.payload, execution: { ...execution, submission } };
  if (payload.review) payload.review = { ...payload.review, submissionDigest: submissionDigest(submission) };
  if (payload.consent && payload.review)
    payload.consent = {
      ...payload.consent,
      submissionDigest: submissionDigest(submission),
      reviewDigest: reviewDigest(payload.review),
    };
  if (payload.witness?.schema === "completion-gate-witness/v1") {
    // Mirrors GenerationThreeMigration's witness rewrite: legacy top-level observed/basis/
    // provenance move under the tagged evidence union; an absent binding is preserved as an
    // explicit historical gap, never guessed.
    const { observed, basis, provenance, override, evidence: existing, ...identity } = payload.witness;
    let evidence = existing;
    if (evidence === undefined) {
      if (basis === undefined && provenance === undefined)
        evidence = { kind: "historical-verdict", gap: "binding-not-recorded" };
      else if (basis === undefined || provenance === undefined)
        throw new Error(`witness ${payload.witness.witnessId} carries a partial evidence binding`);
      else {
        const rePinned = { ...basis, submissionDigest: submissionDigest(submission) };
        evidence = Object.hasOwn(provenance, "adapterId")
          ? {
              kind: "observed",
              observed: observed ?? true,
              basis: rePinned,
              provenance,
              ...(override !== undefined ? { override } : {}),
            }
          : {
              kind: "historical-verdict",
              gap: "adapter-not-recorded",
              basis: rePinned,
              provenance: { source: provenance.source, runId: provenance.runId, rawResult: provenance.rawResult },
            };
      }
    }
    payload.witness = { ...identity, evidence };
  }
  writeFileSync(file, serializeCanonicalEvent({ ...event, payload }));
}

const rows = readFileSync("packages/kernel/fixtures/migration-source/f-lifecycle-suite/events.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(JSON.parse(line).event_json)),
  migration = new GenerationThreeMigration({ readContentObject: () => null });
for (const event of rows) migration.rewrite(event);
const invalidation = migration.invalidations(rows.length + 1, rows.at(-1).occurredAt)[0].event;
writeFileSync(
  path.join(root, "accepted-execution-invalidated-generation-migration.json"),
  serializeCanonicalEvent(invalidation),
);
