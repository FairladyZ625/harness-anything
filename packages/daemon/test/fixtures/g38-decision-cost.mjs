import assert from "node:assert/strict";
import { Hash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEntityKindContract } from "@harness-anything/kernel";

// Count member visits as well as hashing: nested Array.find/some loops may do no IO at all.
const counted = (values, counts) =>
  new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) counts.membersExamined += 1;
      return Reflect.get(target, key, receiver);
    },
  });

export async function measureDecisionCollection(rootDir, size, actionKind, dimension = "claims") {
  const kernel = await import(pathToFileURL(path.join(rootDir, "packages/kernel/src/index.ts")).href),
    {
      compileDecisionWrite,
      renderDecisionDocument,
      getExecutableEntityAction,
      decisionReviewContentDigest,
      sha256Text,
    } = kernel,
    { reduceDecisionDocument } = await import(
      pathToFileURL(path.join(rootDir, "packages/kernel/src/domain/decision-event.ts")).href
    ),
    contract = getExecutableEntityAction(actionKind),
    actor = { principal: { personId: "cost-owner" }, executor: null },
    occurredAt = "2026-11-02T00:00:00.000Z",
    body =
      "# Measured decision\n\n## Background\nProduction collection probe.\n\n## Tradeoffs\nCount work at two scales.\n\n## Conclusion\nMeasure member visits.\n",
    counts = { membersExamined: 0, sha256Calls: 0, sha256Bytes: 0 },
    claims = Array.from({ length: dimension === "claims" ? size : 1 }, (_, index) => ({
      id: `C${index + 1}`,
      text: `Measured claim ${index}.`,
      loadBearing: false,
    })),
    proposal = {
      title: "Measured decision",
      question: "Does one entity's collection stay linear?",
      riskTier: "low",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Measure member visits." }],
      rejected: [{ id: "RJ1", text: "Trust elapsed time.", whyNot: "Shared runners are noisy." }],
      claims,
      fulfillments: [],
      relations: [],
      provenance: [],
      body,
    },
    decision = reduceDecisionDocument(null, {
      decisionId: "dec_COST",
      type: "decision_proposed",
      actor,
      occurredAt,
      workspaceRevision: 1,
      payload: proposal,
    }),
    current = { ...decision, claims: counted(claims, counts) },
    rendered = renderDecisionDocument(decision, null, body),
    document = { body: rendered, blobSha256: sha256Text(rendered) },
    finding = (index) => ({ findingId: `F${index + 1}`, text: `Measured finding ${index}.` });
  if (dimension === "review-findings")
    current.reviews = [
      {
        reviewId: "review-cost",
        reviewContentDigest: decisionReviewContentDigest(current, rendered),
        verdict: "changes_requested",
        reason: "Measured review.",
        findings: counted(
          Array.from({ length: size }, (_, index) => finding(index)),
          counts,
        ),
        evidenceChecked: [],
        reportRef: null,
        actor,
        reviewedAt: occurredAt,
      },
    ];
  const digest = decisionReviewContentDigest(current, rendered),
    commands = {
      accept: { rationale: "Measured acceptance.", judgmentOnlyRationale: "No load-bearing claims require evidence." },
      amend: {
        previous: proposal,
        next: { ...proposal, title: "Amended measured decision" },
        fields: ["title"],
        reason: "Measured amendment.",
      },
      "declare-claim": { claimId: `C${claims.length + 1}`, text: "One more measured claim.", loadBearing: false },
      "fulfill-claim": { claimId: claims.at(-1).id, mode: "evidenced" },
      defer: { reason: "Measured deferral." },
      reject: { reason: "Measured rejection." },
      retire: { reason: "Measured retirement." },
      transition: { targetState: "outcome_retired", reason: "Measured transition." },
      repin: { migrationEvidence: "tasks/task-cost/artifacts/evidence.md" },
      propose: { ...proposal, claims: counted(claims, counts) },
      review: {
        reviewId: "review-new",
        reviewContentDigest: digest,
        verdict: "approved",
        reason: "Measured review.",
        findings: [],
        evidenceChecked: [],
      },
      "respond-review": {
        responses: Array.from({ length: dimension === "review-findings" ? size : 1 }, (_, index) => ({
          reviewId: "review-cost",
          findingId: `F${index + 1}`,
          disposition: "rebut",
          rationale: "Measured response.",
          amendmentRef: null,
        })),
      },
      "override-review": { reviewContentDigest: digest, reviewIds: ["review-cost"], reason: "Measured override." },
    };
  if (["retire", "transition"].includes(contract.id)) current.state = "in_effect";
  if (["respond-review", "override-review"].includes(contract.id) && dimension !== "review-findings")
    current.reviews = [
      {
        reviewId: "review-cost",
        reviewContentDigest: digest,
        verdict: "changes_requested",
        reason: "Measured review.",
        findings: [finding(0)],
        evidenceChecked: [],
        reportRef: null,
        actor,
        reviewedAt: occurredAt,
      },
    ];
  const update = Hash.prototype.update;
  counts.membersExamined = 0;
  Hash.prototype.update = function (chunk, encoding) {
    counts.sha256Calls += 1;
    counts.sha256Bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    return update.call(this, chunk, encoding);
  };
  try {
    assert.ok(commands[contract.id], `missing Decision command fixture: ${actionKind}`);
    const draft = contract.execution.compile({
        action: { kind: actionKind, decisionId: current.decisionId, ...commands[contract.id] },
        actor,
        source: "local",
        session: { runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable" },
        opId: "decision-cost",
        occurredAt,
        workspaceRevision: 2,
      }),
      bundle = compileDecisionWrite({
        event: draft.event,
        currentDecision: contract.id === "propose" ? null : current,
        currentRelations: [],
        currentDocument: contract.id === "propose" ? null : document,
        decisionReviewRequirement: "off",
      });
    assert.equal(bundle.event.schema, "decision-event/v1");
    assert.ok(bundle.blobs.length > 0, "must compile the actual authored document publication");
  } finally {
    Hash.prototype.update = update;
  }
  return { size, counts };
}

export const DECISION_PROBES = Object.freeze(
  Object.fromEntries(
    getEntityKindContract("decision")
      .actionCatalog.actions.filter(
        ({ execution, id }) => execution?.compile && !["assign", "unassign", "reckon"].includes(id),
      )
      .map(({ execution }) => [
        `${execution.ingress}:claims`,
        {
          action: execution.ingress,
          dimension: "claims",
          run: (root, n) => measureDecisionCollection(root, n, execution.ingress),
        },
      ]),
  ),
);
