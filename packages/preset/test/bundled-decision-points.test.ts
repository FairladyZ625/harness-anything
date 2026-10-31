// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionPointBindingDigest,
  decisionWhenMatches,
  type DecisionPointDeclaration,
} from "@harness-anything/kernel";
import { normalizeHistoricalPresetSnapshot } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { validatePresetSnapshotV1, type PresetSnapshotV1 } from "../src/preset.contract.ts";
import { loadCanonicalAssets } from "../src/preset-assets.ts";
import { createCanonicalPresetResolver } from "../src/preset-resolver.ts";
import { defaultAssets } from "../src/preset-resolver-common.ts";

/** The point as it shipped before a ruling stop was a settled outcome (`stopped`). */
const previousPoint: DecisionPointDeclaration = {
    revision: "1",
    on: "dispatch.settled",
    when: { outcome: ["failed", "cancelled", "succeeded"], classification: ["worker_stop", "gate_red"] },
    input: ["report.body", "dispatch.reason", "dispatch.classification"],
    question: "stop-reason",
    show: ["task.dispatches"],
  },
  /** The exact snapshot document every task created before this change froze, captured verbatim. */
  frozenSnapshot = JSON.parse(
    readFileSync(new URL("./fixtures/preset-snapshot/stop-reason-revision-1.json", import.meta.url), "utf8"),
  ) as PresetSnapshotV1;

test("the bundled stop-reason point classifies a ruling stop instead of silently skipping it", () => {
  const definition = loadCanonicalAssets(defaultAssets).compiledVertical.definition,
    point = definition.decisions?.points["dispatch-stop-reason"];
  assert.ok(point, "the bundled vertical still declares the stop-reason point");
  // A worker that stopped to await an owner ruling settles as stopped/awaiting_ruling; the ordinary
  // stop reports keep matching, and a provider fault stays out of this question's scope.
  assert.equal(decisionWhenMatches(point.when, { outcome: "stopped", classification: "awaiting_ruling" }), true);
  assert.equal(decisionWhenMatches(point.when, { outcome: "failed", classification: "gate_red" }), true);
  assert.equal(decisionWhenMatches(point.when, { outcome: "succeeded", classification: "worker_stop" }), true);
  assert.equal(decisionWhenMatches(point.when, { outcome: "failed", classification: "provider_fault" }), false);
  assert.equal(decisionWhenMatches(point.when, { outcome: "cancelled", classification: "awaiting_ruling" }), true);
});

test("the bundled incident disposition declares provider faults and excludes successful worker stops", () => {
  const definition = loadCanonicalAssets(defaultAssets).compiledVertical.definition,
    point = definition.decisions?.points["runtime-incident-worker-stop"];
  assert.ok(point, "the bundled vertical still declares the runtime incident disposition point");
  assert.equal(decisionWhenMatches(point.when, { outcome: "failed", classification: "worker_stop" }), true);
  assert.equal(decisionWhenMatches(point.when, { outcome: "failed", classification: "provider_fault" }), true);
  assert.equal(decisionWhenMatches(point.when, { outcome: "stopped", classification: "worker_stop" }), true);
  assert.equal(decisionWhenMatches(point.when, { outcome: "succeeded", classification: "worker_stop" }), false);
});

test("a repository that enables the point gets the new filter through the real resolution path", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-bundled-decision-points-"));
  try {
    const resolved = await createCanonicalPresetResolver({ userRoot }).resolve({
        presetId: "standard-task",
        verticalId: "software/coding",
        profileId: "baseline",
        locale: "en-US",
        purpose: "task-create",
      }),
      definition = loadCanonicalAssets(defaultAssets).compiledVertical.definition;
    assert.equal(resolved.ok, true, resolved.ok ? "" : JSON.stringify(resolved.error));
    if (!resolved.ok) return;
    // New tasks freeze a snapshot that carries the changed vertical bytes, so the decision executor
    // reads the reviewed filter — not the revision-1 one.
    assert.equal(resolved.snapshot.provenance.verticalSha256, loadCanonicalAssets(defaultAssets).verticalSha256);
    assert.notEqual(resolved.snapshot.digest, frozenSnapshot.digest);
    assert.notEqual(resolved.snapshot.provenance.verticalSha256, frozenSnapshot.provenance.verticalSha256);
    const point = definition.decisions!.points["dispatch-stop-reason"]!;
    assert.equal(
      decisionWhenMatches(point.when, { outcome: "stopped", classification: "awaiting_ruling" }),
      true,
      `resolved snapshot ${resolved.snapshot.digest} must classify a ruling stop`,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("the frozen snapshot an existing task carries still validates and still excludes ruling stops", () => {
  // The installed/frozen path: a task created before this change keeps its own snapshot document and
  // digest, so the completion contract it was reviewed under does not change behind its back.
  // The document is a pre-retirement snapshot, so it names the retired `codeDoc` default; every ledger
  // ingest normalizes that field away before a snapshot is stored, which is what this asserts.
  assert.deepEqual(validatePresetSnapshotV1(normalizeHistoricalPresetSnapshot(frozenSnapshot)), []);
  assert.match(frozenSnapshot.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    decisionWhenMatches(previousPoint.when, { outcome: "stopped", classification: "awaiting_ruling" }),
    false,
  );
  // `settings.decisions.enabledPoints` stores `point@digest-prefix`. The filter change moves the
  // prefix, so the previously reviewed binding pauses instead of silently classifying a new outcome
  // the owner never approved for that provider.
  const definition = loadCanonicalAssets(defaultAssets).compiledVertical.definition,
    point = definition.decisions!.points["dispatch-stop-reason"]!,
    question = definition.decisions!.questions[point.question]!,
    currentPrefix = decisionPointBindingDigest("dispatch-stop-reason", point, question).slice(0, 12),
    previousPrefix = decisionPointBindingDigest("dispatch-stop-reason", previousPoint, question).slice(0, 12);
  assert.notEqual(currentPrefix, previousPrefix);
});
