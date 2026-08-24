// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
  sha256Text,
  stableStringify,
} from "../../kernel/src/index.ts";
import { peopleRosterFromDocument } from "../src/identity/people-roster.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  bootstrapPerson,
  bootstrapRoster,
  git,
  initRepo,
  legacyRoster,
  multiSourceFixture,
  sources,
  unfamiliarDocumentFixture,
} from "./migration-import.fixtures.ts";
test("a destination roster and a source roster both survive the migration without an operator decision", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-people-union-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source);
    writeFileSync(path.join(source, "harness/people.yaml"), legacyRoster);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-people-union"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.outcome, "applied");
    assert.match(
      String(result.summary),
      /\| people-registry \| migrated \| 1 \| PASS \| unioned both rosters into the destination: 2 people \(1 carried from the source: person_dingwen, 1 enriched in place: person_zeyu\), 1 roles \(0 carried from the source\) \|/u,
    );
    const roster = peopleRosterFromDocument(
      readFileSync(path.join(destination, "harness/people.yaml"), "utf8"),
    );
    assert.deepEqual(
      roster.people.map(({ personId }) => personId),
      ["person_zeyu", "person_dingwen"],
    );
    assert.equal(roster.people[0]!.primaryEmail, "lizeyu990625@gmail.com");
    assert.deepEqual(
      [...roster.people[0]!.credentials],
      [...bootstrapPerson.credentials],
    );
    await cell.close();
    cell = undefined;
    assert.equal(
      git(destination, "status", "--porcelain", "--", "harness"),
      "",
    );
    const event = makeTaskEventStore({
      repoId: "migration-people-union",
      rootDir: destination,
    })
      .read()
      .events.find(
        (candidate) =>
          candidate.schema === "migration-import-event/v1" &&
          candidate.payload.migratedFrom === "people.yaml",
      )!;
    assert.deepEqual(
      (event.payload.entity as { readonly destinationPreimage?: unknown })
        .destinationPreimage,
      {
        nodeKind: "file",
        sha256: sha256Text(bootstrapRoster()),
        size: Buffer.byteLength(bootstrapRoster()),
      },
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a roster the destination already covers is reported as covered rather than rewritten", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-people-covered-"),
    ),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source);
    writeFileSync(
      path.join(source, "harness/people.yaml"),
      legacyRoster.replace(/^ +primaryEmail:.*\n/mu, ""),
    );
    initRepo(
      destination,
      bootstrapRoster([
        bootstrapPerson,
        {
          personId: "person_dingwen",
          displayName: "Dingwen",
          roles: ["owner"],
          credentials: [
            {
              kind: "email-address",
              issuer: "example.invalid",
              subject: "dingwen@example.invalid",
            },
          ],
        },
      ]),
    );
    const before = readFileSync(
      path.join(destination, "harness/people.yaml"),
      "utf8",
    );
    cell = await openRepoCell({
      repoId: workspaceId("migration-people-covered"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(
      String(result.summary),
      /\| people-registry \| excluded \| 1 \| PASS \| the destination roster already contains every source entry/u,
    );
    assert.equal(
      readFileSync(path.join(destination, "harness/people.yaml"), "utf8"),
      before,
    );
    assert.equal(
      makeTaskEventStore({
        repoId: "migration-people-covered",
        rootDir: destination,
      })
        .read()
        .events.some(
          (event) =>
            event.schema === "migration-import-event/v1" &&
            event.payload.migratedFrom === "people.yaml",
        ),
      false,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("rosters that genuinely contradict still stop, name the contradiction, and keep the explicit resolution", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-people-contradiction-"),
    ),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source);
    writeFileSync(
      path.join(source, "harness/people.yaml"),
      legacyRoster.replace(
        'displayName: "Zeyu Li"\n    primaryEmail',
        'displayName: "Li Zeyu"\n    primaryEmail',
      ),
    );
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-people-contradiction"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const blocked = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(blocked.exitCode, 1, JSON.stringify(blocked));
    assert.match(String(blocked.summary), /REQUIRED people\.yaml/u);
    assert.match(
      String(blocked.summary),
      /the two rosters cannot be unioned: person person_zeyu declares a different displayName on each side.*resolve with --resolve harness\/people\.yaml=destination\|source/u,
    );
    const resolved = (await cell.run(
      {
        kind: "migrate-import",
        sourceRoots: sources(source),
        resolutions: ["harness/people.yaml=destination"],
      },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(resolved.exitCode, 0, JSON.stringify(resolved));
    assert.equal(
      readFileSync(path.join(destination, "harness/people.yaml"), "utf8"),
      bootstrapRoster(),
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("two independent Git sources merge incrementally with explicit id remaps and deterministic cold rebuilds", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-multi-source-")),
    firstSource = path.join(scratch, "first"),
    secondSource = path.join(scratch, "second"),
    destination = path.join(scratch, "center");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    multiSourceFixture(firstSource, "alpha", "person_alpha");
    multiSourceFixture(secondSource, "beta", "person_beta");
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-multi-source-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-19T00:00:00.000Z",
    });
    const result = (await cell.run(
      {
        kind: "migrate-import",
        sourceRoots: [...sources(firstSource), ...sources(secondSource)],
      },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(
      String(result.summary),
      /Migration import batch \(2\/2 sources processed\)/u,
    );
    assert.match(
      String(result.summary),
      /REMAP task task_shared -> task_shared__[0-9a-f]{10}/u,
    );
    assert.match(
      String(result.summary),
      /REMAP decision dec_SHARED -> dec_SHARED__[0-9a-f]{10}/u,
    );
    const events = makeTaskEventStore({
        repoId: "migration-multi-source-target",
        rootDir: destination,
      })
        .read()
        .events.filter((event) => event.schema === "migration-import-event/v1"),
      tasks = events.filter(
        (event) =>
          event.payload.entity.kind === "task" &&
          event.payload.migratedFrom === "task_shared",
      ),
      decisions = events.filter(
        (event) =>
          event.payload.entity.kind === "decision" &&
          event.payload.migratedFrom === "dec_SHARED",
      );
    assert.equal(tasks.length, 2);
    assert.equal(new Set(tasks.map(({ opId }) => opId)).size, 2);
    assert.deepEqual(
      tasks
        .map((event) =>
          event.payload.entity.kind === "task"
            ? event.payload.entity.task.taskId
            : "",
        )
        .sort(),
      [
        "task_shared",
        tasks
          .map((event) =>
            event.payload.entity.kind === "task"
              ? event.payload.entity.task.taskId
              : "",
          )
          .find((taskId) => taskId.startsWith("task_shared__"))!,
      ].sort(),
    );
    assert.equal(decisions.length, 2);
    assert.equal(new Set(decisions.map(({ opId }) => opId)).size, 2);
    const maps = readdirSync(path.join(destination, "harness/migrations"), {
      recursive: true,
    })
      .filter((entry) => String(entry).endsWith("id-map.json"))
      .map(
        (entry) =>
          JSON.parse(
            readFileSync(
              path.join(destination, "harness/migrations", String(entry)),
              "utf8",
            ),
          ) as {
            readonly sourceGit: { readonly rootCommit: string };
            readonly remappings: readonly {
              readonly entityType: string;
              readonly sourceId: string;
              readonly targetId: string;
            }[];
          },
      );
    assert.equal(maps.length, 2);
    assert.equal(
      new Set(maps.map(({ sourceGit }) => sourceGit.rootCommit)).size,
      2,
    );
    assert.equal(
      maps
        .flatMap(({ remappings }) => remappings)
        .some(
          ({ entityType, sourceId, targetId }) =>
            entityType === "task" &&
            sourceId === "task_shared" &&
            targetId.startsWith("task_shared__"),
        ),
      true,
    );
    const roster = peopleRosterFromDocument(
      readFileSync(path.join(destination, "harness/people.yaml"), "utf8"),
    );
    assert.deepEqual(
      roster.people.map(({ personId }) => personId),
      ["person_zeyu", "person_alpha", "person_beta"],
    );
    const revision = result.revision,
      repeated = (await cell.run(
        { kind: "migrate-import", sourceRoots: [firstSource, secondSource] },
        { actor, source: "local" },
      )) as Record<string, unknown>;
    assert.equal(repeated.exitCode, 0, JSON.stringify(repeated));
    assert.equal(repeated.revision, revision);
    assert.match(
      String(repeated.summary),
      /Already imported from this Git lineage: task=1, decision=1, fact=1, relation=1/u,
    );
    await cell.close();
    cell = undefined;
    const store = makeTaskEventStore({
        repoId: "migration-multi-source-target",
        rootDir: destination,
      }),
      digest = (projectionPath: string): string => {
        const projection = makeTaskProjection({
          rootDir: destination,
          eventStore: store,
          projectionPath,
          now: () => "2026-08-19T00:00:00.000Z",
        });
        try {
          projection.rebuild();
          return sha256Text(
            stableStringify({
              tasks: projection.list(),
              decisions: projection.listDecisions({}),
              decisionGraph: projection.readDecisionGraph(),
              facts: projection.readFactGraph(),
            }),
          );
        } finally {
          projection.close();
        }
      };
    assert.equal(
      digest(path.join(scratch, "cold-one.sqlite")),
      digest(path.join(scratch, "cold-two.sqlite")),
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration rejects dirty, shallow, and multi-root Git sources before any event write", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-git-validation-"),
    ),
    source = path.join(scratch, "source"),
    shallow = path.join(scratch, "shallow"),
    destination = path.join(scratch, "center");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    multiSourceFixture(source, "alpha", "person_alpha");
    sources(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-git-validation"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-19T00:00:00.000Z",
    });
    writeFileSync(
      path.join(source, "uncommitted.txt"),
      "not part of the source cut\n",
    );
    const dirty = await cell.run(
      { kind: "migrate-import", sourceRoots: [source] },
      { actor, source: "local" },
    );
    assert.equal(dirty.outcome, "op_rejected");
    assert.equal(dirty.code, "invalid_migration_source_git");
    assert.match(
      String(dirty.nextAction),
      /not the committed authored Git snapshot.*Commit or discard every tracked and untracked authored change/u,
    );
    assert.equal(
      makeTaskEventStore({
        repoId: "migration-git-validation",
        rootDir: destination,
      }).readHead()?.revision ?? 0,
      0,
    );
    rmSync(path.join(source, "uncommitted.txt"));
    execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      `file://${source}`,
      shallow,
    ]);
    const rejected = await cell.run(
      { kind: "migrate-import", sourceRoots: [shallow] },
      { actor, source: "local" },
    );
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "invalid_migration_source_git");
    assert.match(
      String(rejected.nextAction),
      /shallow authored Git repository.*Fetch complete history/u,
    );
    const unrelatedRoot = git(
      source,
      "commit-tree",
      git(source, "rev-parse", "HEAD^{tree}"),
      "-m",
      "unrelated root",
    );
    git(
      source,
      "merge",
      "-q",
      "--allow-unrelated-histories",
      unrelatedRoot,
      "-m",
      "merge unrelated root",
    );
    const split = await cell.run(
      { kind: "migrate-import", sourceRoots: [source] },
      { actor, source: "local" },
    );
    assert.equal(split.outcome, "op_rejected");
    assert.equal(split.code, "invalid_migration_source_git");
    assert.match(
      String(split.nextAction),
      /2 authored Git root commits.*split unrelated histories/u,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("multi-source dry-run fails closed instead of hiding later-source conflicts", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-multi-dry-run-")),
    first = path.join(scratch, "first"),
    second = path.join(scratch, "second"),
    destination = path.join(scratch, "center");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    multiSourceFixture(first, "alpha", "person_alpha");
    multiSourceFixture(second, "beta", "person_beta");
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-multi-dry-run"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-19T00:00:00.000Z",
    });
    const result = await cell.run(
      {
        kind: "migrate-import",
        sourceRoots: [...sources(first), ...sources(second)],
        dryRun: true,
      },
      { actor, source: "local" },
    );
    assert.equal(result.outcome, "op_rejected");
    assert.equal(result.code, "multi_source_dry_run_requires_staging");
    assert.match(
      String(result.nextAction),
      /cannot truthfully predict later-source document and id conflicts.*disposable initialized center/u,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
