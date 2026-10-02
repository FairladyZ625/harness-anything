// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { realizeTaskPlanFixture, realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import {
  commitDelivery,
  initRepo,
  submissionOutcome,
  writeCloseout,
  writeSettingsFixture,
} from "./review-independence.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

type Receipt = {
  readonly outcome: string;
  readonly code?: string;
  readonly rejectionExplanation?: string | null;
  readonly opId: string;
  readonly evidence?: string;
  readonly packagePath?: string;
};

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-center-arbiter-ci-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

const person = (
  personId: string,
  executorId: string | null,
  ...groups: readonly ("contributor" | "maintainer" | "admin")[]
) =>
  groups.reduce(
    (binding, group) => withPolicyGroup(binding, group),
    withPolicyGroup(
      {
        actor: {
          principal: { personId },
          executor: executorId === null ? null : { kind: "agent" as const, id: executorId },
        },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "contributor",
    ),
  );
const proposer = person("person-proposer", "proposer-agent", "maintainer"),
  reviewer = person("person-reviewer", null, "maintainer"),
  arbiter = person("person-arbiter", null, "maintainer"),
  secondArbiter = person("person-second-arbiter", null, "maintainer");

const outcomes = (receipts: readonly Receipt[]) => receipts.map(({ outcome, code }) => [outcome, code ?? null]).sort();
const receiptJson = (receipt: Receipt) => JSON.parse(String(receipt.evidence)) as Record<string, unknown>;

function decisionRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Center Arbiter Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "center-arbiter@example.invalid"]);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  reviewIndependence: execution\n",
  );
  execFileSync("git", ["-C", rootDir, "add", "."]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "base"]);
}

const proposal = (title: string) =>
  ({
    kind: "decision-propose",
    body: realizedDecisionBody(title),
    jsonInput: JSON.stringify({
      title,
      question: "Should the center record this adjudication?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Record it on the center" }],
      rejected: [{ id: "RJ1", text: "Leave it without an entrance", whyNot: "Nobody could adjudicate" }],
      claims: [{ id: "C1", text: "The center owns the ledger.", loadBearing: true }],
      fulfillments: [],
    }),
  }) as const;

test("a center-local arbiter reviews, overrides and rejects a Decision while its author cannot review it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-center-arbiter-decision-"));
  decisionRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("center-arbiter-decision"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "center-arbiter-decision-test",
    mode: "remote-center",
  });
  try {
    const run = (action: Readonly<Record<string, unknown>>, binding: typeof proposer) =>
        cell.run(action as never, binding) as Promise<Receipt>,
      propose = async (title: string) => {
        const proposed = await run(proposal(title), proposer);
        assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
        const decisionId = receiptJson(proposed).decisionId as string,
          shown = receiptJson(await run({ kind: "decision-show", decisionId, includeBody: true }, proposer))
            .decision as { readonly currentReviewContentDigest: string };
        return { decisionId, digest: shown.currentReviewContentDigest };
      },
      review = (decisionId: string, digest: string, reviewId: string) => {
        const reportRef = `decisions/decision-${decisionId}/artifacts/reports/${reviewId.slice("review-".length)}.md`,
          target = path.join(rootDir, "harness", ...reportRef.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "# Independent review\n\nThe current Decision cut was reviewed.\n");
        return {
          kind: "decision-review",
          decisionId,
          reviewId,
          reviewContentDigest: digest,
          verdict: "changes_requested",
          reason: "The proposal needs a named correction.",
          findings: [{ findingId: "finding-1", text: "Name the correction before acceptance." }],
          evidenceChecked: [],
          reportRef,
        };
      };
    // A changes_requested review files its ask on the proposal owner, who must be a rostered person.
    const rostered = await run(
      {
        kind: "people-add",
        personId: proposer.actor.principal.personId,
        displayName: "Proposal Owner",
        role: "administrator",
        commandClass: ["admin"],
        credentialKind: "email-address",
        credentialIssuer: "example.invalid",
        credentialSubject: "proposal-owner@example.invalid",
      },
      withPolicyGroup(proposer, "admin"),
    );
    assert.equal(rostered.outcome, "applied", JSON.stringify(rostered));
    const { decisionId, digest } = await propose("Center adjudication");

    // Independence is the domain's own check: the center entrance does not let an author review itself.
    const selfReview = await run(review(decisionId, digest, "review-self"), proposer);
    assert.deepEqual(
      [selfReview.outcome, selfReview.code],
      ["op_rejected", "actor_unauthorized"],
      JSON.stringify(selfReview),
    );

    const reviewed = await run(review(decisionId, digest, "review-center"), reviewer);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const overridden = await run(
      {
        kind: "decision-override-review",
        decisionId,
        reviewContentDigest: digest,
        reviewIds: ["review-center"],
        reason: "The center arbiter explicitly accepts the named disagreement.",
      },
      arbiter,
    );
    assert.equal(overridden.outcome, "applied", JSON.stringify(overridden));
    const rejected = await run({ kind: "decision-reject", decisionId, reason: "The center arbiter rejects." }, arbiter);
    assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));

    // Two arbiters adjudicating one Decision at once: the Decision state machine admits one.
    const raced = await propose("Center adjudication race"),
      reject = (binding: typeof arbiter, reason: string) =>
        run({ kind: "decision-reject", decisionId: raced.decisionId, reason }, binding),
      adjudications = await Promise.all([
        reject(arbiter, "The first arbiter rejects."),
        reject(secondArbiter, "The second arbiter rejects."),
      ]);
    assert.deepEqual(
      outcomes(adjudications),
      [
        ["applied", null],
        ["op_rejected", "invalid_transition"],
      ],
      JSON.stringify(adjudications),
    );
    // Two reviewers claiming one review id on one cut: the first record stands, the second is refused.
    const contested = await propose("Center review race"),
      reviews = await Promise.all(
        [reviewer, secondArbiter].map((binding) =>
          run(review(contested.decisionId, contested.digest, "review-contested"), binding),
        ),
      );
    assert.deepEqual(
      outcomes(reviews),
      [
        ["applied", null],
        ["op_rejected", "invalid_transition"],
      ],
      JSON.stringify(reviews),
    );
    assert.match(
      String(reviews.find(({ outcome }) => outcome !== "applied")?.rejectionExplanation),
      /reviewId=review-contested already exists/u,
    );

    const reader = makeTaskEventReader({ repoId: workspaceId("center-arbiter-decision"), rootDir });
    try {
      const events = reader.read().events,
        of = (id: string, type: string) =>
          events.filter(
            (event) => event.schema === "decision-event/v1" && event.type === type && event.decisionId === id,
          );
      assert.equal(of(raced.decisionId, "decision_rejected").length, 1);
      assert.equal(of(contested.decisionId, "decision_review_recorded").length, 1);
      assert.deepEqual(
        events.map((event) => event.workspaceRevision),
        events.map((_, index) => index + 1),
        "the center queue assigned one gapless revision per accepted write",
      );
    } finally {
      await reader.drain();
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a center-local reviewer records an Execution Review while the submitting executor cannot", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-center-arbiter-task-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    writeSettingsFixture(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("center-arbiter-task"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "center-arbiter-task-test",
      mode: "remote-center",
    });
    const run = (action: Readonly<Record<string, unknown>>, binding: typeof proposer) =>
      cell!.run(action as never, binding) as Promise<Receipt>;
    const taskId = "task-center-review",
      executionId = "exec-center-review";
    const created = await run({ kind: "task-create", taskId, title: "Center review" }, proposer);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, proposer);
    await realizeTaskPlanFixture(rootDir, String(created.packagePath), (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }, proposer),
    );
    assert.equal((await run({ kind: "task-start", taskId, executionId }, proposer)).outcome, "applied");
    await commitDelivery(cell, rootDir);
    writeCloseout(rootDir, created.packagePath);
    assert.equal(submissionOutcome(await run({ kind: "task-submit", taskId, executionId }, proposer)), "applied");
    const forwarded = await run(
      { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward the center cut." },
      proposer,
    );
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"] }),
    );
    const reports = path.join(rootDir, "harness", String(created.packagePath), "artifacts", "reports");
    mkdirSync(reports, { recursive: true });
    for (const id of ["r-self", "r-center"])
      writeFileSync(path.join(reports, `${id}.md`), `# Review ${id}\n\nPhysical review findings.\n`);
    const review = (reviewId: string, binding: typeof proposer) =>
      run({ kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" }, binding);

    const selfReview = await review("r-self", proposer);
    assert.deepEqual(
      [selfReview.outcome, selfReview.code],
      ["op_rejected", "actor_unauthorized"],
      JSON.stringify(selfReview),
    );
    // Two reviewers recording one review id on one submission: the task state machine admits one.
    const reviews = await Promise.all([review("r-center", reviewer), review("r-center", secondArbiter)]);
    assert.deepEqual(
      outcomes(reviews),
      [
        ["applied", null],
        ["op_rejected", "invalid_transition"],
      ],
      JSON.stringify(reviews),
    );
    assert.match(
      String(reviews.find(({ outcome }) => outcome !== "applied")?.rejectionExplanation),
      /append-only Review history requires a new review id/u,
    );
    const reader = makeTaskEventReader({ repoId: workspaceId("center-arbiter-task"), rootDir });
    try {
      assert.equal(reader.read().events.filter((event) => event.type === "review_recorded").length, 1);
    } finally {
      await reader.drain();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the center admits no unauthenticated arbiter and the edge admits no local review command", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-center-arbiter-negative-")),
    userRoot = path.join(parent, "user");
  for (const [repoId, mode] of [
    ["center", "remote-center"],
    ["edge", "remote-edge"],
  ] as const) {
    rosterRepo(path.join(parent, repoId), repoId);
    registerDaemonRepo({
      canonicalRoot: path.join(parent, repoId),
      repoId,
      mode,
      userRoot,
      createConvenienceLinks: false,
    });
  }
  const host = await openDaemonHost({ daemonId: "center-arbiter", userRoot }),
    // The node is registered to a person who holds no grant on the center repository.
    owners = await fleetNodeOwners({
      userRoot,
      owners: { "edge-one": "writer" },
      repoIds: ["center"],
      grantAll: false,
    });
  try {
    await host.attachmentsSettled();
    const digest = `sha256:${"0".repeat(64)}`,
      commands = [
        { kind: "decision-reject", decisionId: "dec_0000000000000000000000ABCD", reason: "No entrance." },
        {
          kind: "decision-review",
          decisionId: "dec_0000000000000000000000ABCD",
          reviewId: "review-negative",
          reviewContentDigest: digest,
          verdict: "approved",
          reason: "No entrance.",
          findings: [],
          evidenceChecked: [],
          reportRef: "decisions/decision-dec_0000000000000000000000ABCD/artifacts/reports/negative.md",
        },
        {
          kind: "decision-override-review",
          decisionId: "dec_0000000000000000000000ABCD",
          reviewContentDigest: digest,
          reviewIds: ["review-negative"],
          reason: "No entrance.",
        },
        {
          kind: "task-review-execution",
          taskId: "task-negative",
          executionId: "exec-negative",
          reviewId: "review-negative",
          verdict: "approved",
          reason: "No entrance.",
          evidenceChecked: ["tests"],
        },
      ],
      stranger = {
        ...auth,
        unixSocketOwnerBoundary: { ...auth.unixSocketOwnerBoundary, ownerUid: (process.getuid?.() ?? 0) + 1_000 },
      };
    for (const action of commands) {
      const onEdge = (await host.run("edge", action as never, auth)) as Receipt;
      assert.deepEqual([onEdge.outcome, onEdge.code], ["op_rejected", "repo_mode_read_only"], action.kind);
      const unknown = (await host.run("center", action as never, stranger)) as Receipt;
      assert.deepEqual([unknown.outcome, unknown.code], ["op_rejected", "credential_unknown"], action.kind);
      // The roster principal holds no arbiter command class: the center now reaches the same
      // authorization evaluation every other write gets, and that evaluation refuses it.
      const unprivileged = (await host.run("center", action as never, auth)) as Receipt;
      assert.deepEqual(
        [unprivileged.outcome, unprivileged.code],
        ["op_rejected", "authorization_denied"],
        `${action.kind} ${JSON.stringify(unprivileged)}`,
      );
      // An assignment-bound source is evaluated the same way; the mode cell no longer answers for it.
      const assigned = (await host.run(
        "center",
        action as never,
        owners.auth({
          nodeId: "edge-one",
          repoId: "center",
          taskId: "task-negative",
          executionId: "exec-negative",
          assignmentId: "assignment-edge-one",
          viewId: "edge-one_task-negative",
          expiresAt: "2099-01-01T00:00:00.000Z",
          paths: [],
        }),
      )) as Receipt;
      assert.deepEqual(
        [assigned.outcome, assigned.code],
        ["op_rejected", "authorization_denied"],
        `${action.kind} ${JSON.stringify(assigned)}`,
      );
    }
  } finally {
    await owners.close();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
