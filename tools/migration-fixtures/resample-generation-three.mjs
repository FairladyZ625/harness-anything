#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializeCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync-canonical-events.ts";
import { submissionDigest } from "../../packages/kernel/src/domain/execution.ts";
import { reviewDigest } from "../../packages/kernel/src/domain/review.ts";
import { GenerationThreeMigration } from "../../packages/kernel/src/store/generation-three-migration.ts";

const root = "packages/kernel/fixtures/canonical-events/task-event-v1";

function completionContract(gateIds) {
  return {
    gates: [...new Set(gateIds)].map((gateId) =>
      gateId === "code-doc-reconciliation"
        ? {
            gateId,
            appliesTo: "code",
            witness: { adapterId: "code-doc-reconciliation", adapterOptions: {} },
          }
        : {
            gateId,
            appliesTo: "code",
            witness: {
              adapterId: "github-actions",
              adapterOptions: {
                workflows: ["fixture-ci"],
                branch: "main",
                event: "push",
                coverage: "exact",
                selection: "newest",
              },
            },
          },
    ),
  };
}

for (const name of readdirSync(root).filter((candidate) => candidate.endsWith(".json"))) {
  const file = path.join(root, name),
    event = JSON.parse(readFileSync(file, "utf8")),
    execution = event.payload?.execution;
  if (!execution?.submission || execution.submission.completionContract) continue;
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
  if (payload.witness) {
    if (payload.witness.basis)
      payload.witness = {
        ...payload.witness,
        basis: { ...payload.witness.basis, submissionDigest: submissionDigest(submission) },
      };
    if (payload.witness.provenance && !payload.witness.provenance.adapterId)
      payload.witness = {
        ...payload.witness,
        provenance: { ...payload.witness.provenance, adapterId: "github-actions" },
      };
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
