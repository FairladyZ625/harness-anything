// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileDecisionWrite, decisionWritePlan, renderDecisionDocument, sha256Text } from "@harness-anything/kernel";
import { projectDecisionReadiness } from "../../src/projection/decision-readiness-projection.ts";
import { readDecisionDocumentState, reduceDecisionEvent } from "../../src/projection/decision-event-projection.ts";
import { withTempStore } from "./helpers.ts";

import {
  accepted,
  applyDecision,
  compileCurrent,
  decisionProjectionDatabase,
  git,
  projectionFixture,
  proposal,
  testReadinessSource,
} from "./relation-graph-projection.fixtures.ts";

test("Decision readiness is commit-bound and ignores uncommitted worktree guesses", () => {
  withTempStore((rootDir) => {
    git(rootDir, "init");
    git(rootDir, "config", "user.name", "Fixture");
    git(rootDir, "config", "user.email", "fixture@example.test");
    mkdirSync(path.join(rootDir, "packages/kernel"), { recursive: true });
    writeFileSync(path.join(rootDir, "packages/kernel/index.ts"), "export const ready = true;\n");
    git(rootDir, "add", ".");
    git(rootDir, "commit", "-m", "base", {
      GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z",
    });
    const base = git(rootDir, "rev-parse", "HEAD"),
      decision = {
        decisionId: "dec_READY",
        proposedAt: "2026-08-02T00:00:00.000Z",
        appliesTo: { modules: ["kernel"], productLines: [] },
      };
    const source = testReadinessSource();
    let readiness = projectDecisionReadiness({ rootDir, commitSha: base, decisions: [decision] }, source)[0]!;
    assert.equal(readiness.appliesToDrift.state, "clear");
    assert.equal(readiness.conflictMarker.state, "clear");
    writeFileSync(path.join(rootDir, "packages/kernel/index.ts"), "<<<<<<< local\n=======\n>>>>>>> remote\n");
    readiness = projectDecisionReadiness({ rootDir, commitSha: base, decisions: [decision] }, source)[0]!;
    assert.equal(readiness.conflictMarker.state, "clear", "uncommitted worktree markers are not canonical truth");
    git(rootDir, "add", ".");
    git(rootDir, "commit", "-m", "canonical conflict", {
      GIT_AUTHOR_DATE: "2026-08-03T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-03T00:00:00Z",
    });
    const head = git(rootDir, "rev-parse", "HEAD");
    readiness = projectDecisionReadiness({ rootDir, commitSha: head, decisions: [decision] }, source)[0]!;
    assert.equal(readiness.appliesToDrift.state, "drift");
    assert.deepEqual(readiness.appliesToDrift.paths, ["packages/kernel/index.ts"]);
    assert.equal(readiness.conflictMarker.state, "conflict");
    assert.deepEqual(readiness.conflictMarker.paths, ["packages/kernel/index.ts"]);
    const unknown = projectDecisionReadiness(
      {
        rootDir,
        commitSha: head,
        decisions: [
          {
            ...decision,
            appliesTo: { modules: ["missing-module"], productLines: [] },
          },
        ],
      },
      source,
    )[0]!;
    assert.equal(unknown.appliesToDrift.state, "unknown");
    assert.equal(unknown.conflictMarker.state, "unknown");
  });
});

test("Decision readiness batches canonical Git reads across the ledger", () => {
  const calls: string[][] = [];
  const source = {
      run: (_rootDir: string, args: readonly string[]) => {
        calls.push([...args]);
        return {
          ok: true,
          stdout: args[0] === "ls-tree" ? "packages/kernel/index.ts" : "",
        };
      },
    },
    count = 570;
  const decisions = Array.from({ length: count }, (_, index) => ({
    decisionId: `dec_SCALE_${index}`,
    proposedAt: new Date(Date.UTC(2026, 7, 1) + index * 1_000).toISOString(),
    appliesTo: { modules: ["kernel"], productLines: [] },
  }));
  const readiness = projectDecisionReadiness({ rootDir: "/fixture", commitSha: "a".repeat(40), decisions }, source);
  assert.equal(readiness.length, count);
  assert.equal(
    readiness.every((row) => row.appliesToDrift.state === "clear" && row.conflictMarker.state === "clear"),
    true,
  );
  assert.equal(
    calls.length,
    3,
    `readiness opened ${calls.length} Git processes for ${count} decisions sharing one canonical scope`,
  );
});

test("Decision readiness preserves scope, sorted paths and Git log order with non-monotonic commit times", () => {
  const commitSha = "a".repeat(40);
  const first = "2026-08-02T00:00:00Z",
    newest = "2026-08-05T00:00:00Z";
  const files = ["lib-old/other", "packages/lib/z", "lib.ts", "lib/config/a", "lib/config/b", "lib-elsewhere/x"];
  const lines = (file: string) =>
    ["<<<<<<<", "=======", ">>>>>>>"].map((marker, index) => `${commitSha}:${file}:${index + 1}:${marker}`);
  const source = {
    run: (_rootDir: string, [command]: readonly string[]) => ({
      ok: true,
      stdout:
        command === "ls-tree"
          ? files.join("\n")
          : command === "log"
            ? `\x1e${first}\nlib/config/b\n\x1e${newest}\nlib/deleted\npackages/lib/z\nlib/config/a\nlib/config/b\nlib-elsewhere/x\nlib.ts`
            : [
                ...lines("lib/config/b"),
                ...lines("packages/lib/z"),
                ...lines("lib-elsewhere/x"),
                "lib/config/a:7:<<<<<<<",
              ].join("\n"),
    }),
  };
  const decisions = [
    ["lib", "./lib/config/", "packages\\lib", "lib.ts", "missing"],
    ["lib/config/b"],
    ["lib/deleted", "../lib"],
    ["lib-old"],
    ["lib/config/a", "missing"],
    ["lib", "lib/config", "packages/lib"],
  ].map((modules, index) => ({
    decisionId: `dec_${index}`,
    proposedAt: index === 3 ? first : index >= 4 ? "invalid" : newest,
    appliesTo: { modules, productLines: [] },
  }));
  const result = projectDecisionReadiness({ rootDir: "/fixture", commitSha, decisions }, source);
  assert.deepEqual(
    result.map(({ appliesToDrift, conflictMarker }) => [
      appliesToDrift.state,
      appliesToDrift.paths,
      appliesToDrift.lastCommitAt,
      conflictMarker.state,
      conflictMarker.paths,
    ]),
    [
      [
        "drift",
        ["lib.ts", "lib/config/a", "lib/config/b", "packages/lib/z"],
        first,
        "conflict",
        ["lib/config/b", "packages/lib/z"],
      ],
      ["drift", ["lib/config/b"], first, "conflict", ["lib/config/b"]],
      ["unknown", [], null, "unknown", []],
      ["clear", ["lib-old"], null, "clear", ["lib-old"]],
      ["unknown", [], null, "unknown", []],
      ["unknown", [], null, "conflict", ["lib/config/b", "packages/lib/z"]],
    ],
  );
  assert.equal(result[2]?.appliesToDrift.summary, "Unresolved canonical applies_to module(s): lib/deleted, ../lib.");
  assert.equal(result[4]?.conflictMarker.summary, "Unresolved canonical applies_to module(s): missing.");
});

test("Decision readiness projects 800 decisions and 60,000 history paths in under 100 ms CPU time", (t) => {
  const moduleName = (index: number) => `packages/module-${index}`;
  const files = Array.from({ length: 5_000 }, (_, index) => `${moduleName(index % 50)}/file-${index}.ts`);
  const timestamp = "2026-08-05T00:00:00Z";
  const log = Array.from({ length: 12 }, () => `\x1e${timestamp}\n${files.join("\n")}\n`).join("");
  const decisions = Array.from({ length: 800 }, (_, index) => ({
    decisionId: `dec_${index}`,
    proposedAt: new Date(Date.parse(timestamp) - index * 1_000).toISOString(),
    appliesTo: { modules: [moduleName(index % 50), moduleName((index + 1) % 50)], productLines: [] },
  }));
  const tree = files.join("\n");
  const source = {
    run: (_rootDir: string, [command]: readonly string[]) => ({
      ok: true,
      stdout: command === "ls-tree" ? tree : command === "log" ? log : "",
    }),
  };

  const wallStart = performance.now(),
    cpuStart = process.cpuUsage();
  const readiness = projectDecisionReadiness({ rootDir: "/fixture", commitSha: "a".repeat(40), decisions }, source);
  const cpu = process.cpuUsage(cpuStart),
    cpuMs = (cpu.user + cpu.system) / 1_000;
  t.diagnostic(
    `readiness calculation: ${cpuMs.toFixed(2)} ms CPU, ${(performance.now() - wallStart).toFixed(2)} ms wall`,
  );
  assert.ok(cpuMs < 100, `readiness calculation used ${cpuMs.toFixed(2)} ms CPU (budget: 100 ms)`);
  assert.equal(readiness.length, 800);
  assert.ok(
    readiness.every(({ appliesToDrift }) => appliesToDrift.state === "drift" && appliesToDrift.paths.length === 200),
  );
});

test("Replay accepts a document today's renderer no longer reproduces, as long as its content hash matches the signed claim", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      draft = proposal(1, "dec_LEGACY_RENDER"),
      compiled = compileDecisionWrite({
        decisionReviewRequirement: "off",
        event: draft,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      });
    // Stand in for a document written by an older renderer: strip a frontmatter line today's renderer always emits.
    const legacyBody = compiled.body.replace(/^provenance: .*\n/mu, "");
    assert.notEqual(legacyBody, compiled.body, "fixture must actually differ from what the current renderer produces");
    const legacySha = sha256Text(legacyBody),
      legacySize = Buffer.byteLength(legacyBody, "utf8");
    const event = {
      ...compiled.event,
      payload: {
        ...compiled.event.payload,
        decisionDocumentClaim: {
          ...compiled.event.payload.decisionDocumentClaim,
          sha256: legacySha,
          size: legacySize,
        },
      },
    };
    fixture.blobs.set(legacySha, Buffer.from(legacyBody, "utf8"));
    fixture.appendEvent(event);
    fixture.projection.apply(event, decisionWritePlan(event));
    assert.equal(
      fixture.projection.readDecision("dec_LEGACY_RENDER").decision?.decisionId,
      "dec_LEGACY_RENDER",
      "a historical document must replay even though the renderer has since evolved",
    );
  });
});

test("Decision projection requires an exact plan, consent pin, and document base", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      draft = proposal(1, "dec_EXACT"),
      compiled = compileDecisionWrite({
        decisionReviewRequirement: "off",
        event: draft,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      });
    assert.throws(() => fixture.projection.apply(compiled.event), /write plan/u);
    assert.equal(fixture.projection.readDecision("dec_EXACT").decision, null);
    applyDecision(fixture, draft);
    const next = compileCurrent(fixture, accepted(2, "dec_EXACT")),
      tampered = {
        ...next.event,
        payload: {
          ...next.event.payload,
          judgmentConsent: {
            ...next.event.payload.judgmentConsent,
            machineDigest: `sha256:${"0".repeat(64)}` as const,
          },
        },
      },
      stale = {
        ...next.event,
        payload: { ...next.event.payload, baseDocumentSha256: "0".repeat(64) },
      };
    fixture.blobs.set(next.blobs[0].sha256, Buffer.from(next.body));
    assert.throws(() => fixture.projection.apply(tampered, decisionWritePlan(tampered)), /machine content cut/u);
    assert.throws(() => fixture.projection.apply(stale, decisionWritePlan(stale)), /base.*mismatch/u);
    assert.equal(fixture.projection.readDecision("dec_EXACT").decision?.state, "proposed");
  });
});

test("Decision projection preserves authored option and claim order across two-digit ids", () => {
  const draft = proposal(1, "dec_ORDER"),
    numbered = (prefix: string) => Array.from({ length: 10 }, (_, index) => `${prefix}${index + 1}`),
    event: typeof draft = {
      ...draft,
      payload: {
        ...draft.payload,
        chosen: numbered("CH").map((id) => ({ id, text: `Chosen ${id}` })),
        rejected: numbered("RJ").map((id) => ({
          id,
          text: `Rejected ${id}`,
          whyNot: `Why not ${id}`,
        })),
        claims: numbered("C").map((id) => ({
          id,
          text: `Claim ${id}`,
          loadBearing: true,
        })),
      },
    },
    compiled = compileDecisionWrite({
      decisionReviewRequirement: "off",
      event,
      currentDecision: null,
      currentRelations: [],
      currentDocument: null,
    }),
    db = decisionProjectionDatabase();
  try {
    reduceDecisionEvent(db, compiled.event);
    const state = readDecisionDocumentState(db, event.decisionId);
    assert.ok(state);
    assert.deepEqual(
      state.chosen.map(({ id }) => id),
      numbered("CH"),
    );
    assert.deepEqual(
      state.rejected.map(({ id }) => id),
      numbered("RJ"),
    );
    assert.deepEqual(
      state.claims.map(({ id }) => id),
      numbered("C"),
    );
    assert.equal(renderDecisionDocument(state, null, event.payload.body), compiled.body);
  } finally {
    db.close();
  }
});
