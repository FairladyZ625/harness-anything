// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection, sha256Text, stableStringify } from "../../kernel/src/index.ts";
import { peopleRosterFromDocument } from "../src/identity/people-roster.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, openFencedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

import {
  actor,
  bootstrapPerson,
  bootstrapRoster,
  coverageCompleteFixture,
  git,
  initRepo,
  legacyRoster,
  multiSourceFixture,
  sources,
  symbolicLinkFixture,
  unfamiliarDocumentFixture,
} from "./migration-import.fixtures.ts";

// Fragment from migration-import-destination-resolution.integration.test.ts: that suite opened the
// fenced repo-cell fixture, not the bootstrapped one.
{
  const openRepoCell = openFencedRepoCell;
  test("a different destination document at the same path requires a decision and reports both sides", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-conflict-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new"),
      sourceBody = "# Field observation\n\nUnknown directories are ordinary authored content.\n",
      destinationBody = "# Existing target\n\nKeep this version.\n";
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      initRepo(destination);
      const target = path.join(destination, "harness/field-notes/2024/xyz.md");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, destinationBody);
      git(destination, "add", ".");
      git(destination, "commit", "-qm", "existing target document");
      cell = await openRepoCell({
        repoId: workspaceId("migration-repo-conflict-target"),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-daemon",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      const result = (await cell.run(
        { kind: "migrate-import", sourceRoots: sources(source) },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.equal(result.outcome, "op_rejected");
      assert.equal(readFileSync(target, "utf8"), destinationBody);
      assert.match(String(result.summary), /REQUIRED field-notes\/2024\/xyz\.md/u);
      assert.match(
        String(result.summary),
        new RegExp(`source sha256=${sha256Text(sourceBody)}.*destination sha256=${sha256Text(destinationBody)}`, "u"),
      );
      const resolution = ["harness/field-notes/2024/xyz.md=source"],
        preview = (await cell.run(
          {
            kind: "migrate-import",
            sourceRoots: sources(source),
            resolutions: resolution,
            dryRun: true,
          },
          { actor, source: "local" },
        )) as Record<string, unknown>;
      assert.equal(preview.exitCode, 0, JSON.stringify(preview));
      assert.equal(preview.outcome, "pending");
      assert.equal(preview.acceptance, null);
      for (const facet of [preview.projection, preview.git, preview.worktree]) {
        assert.equal((facet as { readonly state: string }).state, "pending");
        assert.equal((facet as { readonly cut: unknown }).cut, null);
      }
      assert.match(String(preview.summary), /resolved: source/u);
      assert.equal(
        makeTaskEventReader({
          repoId: "migration-repo-conflict-target",
          rootDir: destination,
        }).readHead()?.revision ?? 0,
        0,
      );
      assert.equal(readFileSync(target, "utf8"), destinationBody);
      const applied = (await cell.run(
        {
          kind: "migrate-import",
          sourceRoots: sources(source),
          resolutions: resolution,
        },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.equal(applied.exitCode, 0, JSON.stringify(applied));
      await waitForFixturePublication(cell, String(applied.opId), { actor, source: "local" });
      assert.equal(readFileSync(target, "utf8"), sourceBody);
      assert.equal(
        readdirSync(path.dirname(target)).some((name) => name.includes(".conflict-")),
        false,
      );
      const event = makeTaskEventReader({
        repoId: "migration-repo-conflict-target",
        rootDir: destination,
      })
        .read()
        .events.find(
          (candidate) =>
            candidate.schema === "migration-import-event/v1" &&
            candidate.payload.migratedFrom === "field-notes/2024/xyz.md",
        )!;
      assert.equal(event.payload.entity.kind, "repo-document");
      assert.deepEqual((event.payload.entity as { readonly destinationPreimage?: unknown }).destinationPreimage, {
        nodeKind: "file",
        sha256: sha256Text(destinationBody),
        size: Buffer.byteLength(destinationBody),
      });
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("destination resolution keeps the visible target and explicitly accounts for the discarded source", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-destination-resolution-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new"),
      sourceBody = "# Legacy\n",
      destinationBody = "# Initialized\n";
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      initRepo(destination);
      const target = path.join(destination, "harness/field-notes/2024/xyz.md");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(path.join(source, "harness/field-notes/2024/xyz.md"), sourceBody);
      writeFileSync(target, destinationBody);
      git(destination, "add", ".");
      git(destination, "commit", "-qm", "initialized target");
      cell = await openRepoCell({
        repoId: workspaceId("migration-destination-resolution"),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-daemon",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      const result = (await cell.run(
        {
          kind: "migrate-import",
          sourceRoots: sources(source),
          resolutions: ["harness/field-notes/2024/xyz.md=destination"],
        },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      await waitForFixturePublication(cell, String(result.opId), { actor, source: "local" });
      assert.equal(readFileSync(target, "utf8"), destinationBody);
      assert.match(
        String(result.summary),
        /\| field-notes\/2024\/xyz\.md \| excluded \| 1 \| PASS \| resolved: destination; discarded source kind=file, source sha256=[0-9a-f]{64}, source bytes=9; kept destination kind=file, destination sha256=[0-9a-f]{64}, destination bytes=14 \|/u,
      );
      assert.equal(
        makeTaskEventReader({
          repoId: "migration-destination-resolution",
          rootDir: destination,
        })
          .read()
          .events.some(
            (event) =>
              event.schema === "migration-import-event/v1" && event.payload.migratedFrom === "field-notes/2024/xyz.md",
          ),
        false,
      );
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(
    "source resolution replaces a committed symbolic link without dereferencing or hiding its preimage",
    {
      skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
    },
    async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-link-resolution-")),
        source = path.join(scratch, "legacy"),
        destination = path.join(scratch, "new"),
        sourceTarget = "../legacy.md",
        destinationTarget = "../initialized.md";
      let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
      try {
        symbolicLinkFixture(source, sourceTarget);
        initRepo(destination);
        const directory = path.join(destination, "harness/field-notes"),
          target = path.join(directory, "latest.md");
        mkdirSync(directory, { recursive: true });
        symlinkSync(destinationTarget, target);
        git(destination, "add", ".");
        git(destination, "commit", "-qm", "initialized link");
        cell = await openRepoCell({
          repoId: workspaceId("migration-link-resolution"),
          rootDir: canonicalRoot(destination),
          ownerId: "migration-daemon",
          now: () => "2026-06-01T00:00:00.000Z",
        });
        const result = (await cell.run(
          {
            kind: "migrate-import",
            sourceRoots: sources(source),
            resolutions: ["harness/field-notes/latest.md=source"],
          },
          { actor, source: "local" },
        )) as Record<string, unknown>;
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        await waitForFixturePublication(cell, String(result.opId), { actor, source: "local" });
        assert.equal(readlinkSync(target), sourceTarget);
        assert.equal(
          readdirSync(directory).some((name) => name.includes(".conflict-")),
          false,
        );
        assert.match(
          String(result.summary),
          /resolved: source; kept source kind=symbolic-link[\s\S]*source link target="\.\.\/legacy\.md"[\s\S]*destination link target="\.\.\/initialized\.md"/u,
        );
        const event = makeTaskEventReader({
          repoId: "migration-link-resolution",
          rootDir: destination,
        })
          .read()
          .events.find(
            (candidate) =>
              candidate.schema === "migration-import-event/v1" &&
              candidate.payload.migratedFrom === "field-notes/latest.md",
          )!;
        assert.deepEqual((event.payload.entity as { readonly destinationPreimage?: unknown }).destinationPreimage, {
          nodeKind: "symbolic-link",
          sha256: sha256Text(destinationTarget),
          size: Buffer.byteLength(destinationTarget),
        });
      } finally {
        await cell?.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  test(
    "source resolution can replace a committed destination link with a regular file",
    {
      skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
    },
    async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-file-over-link-")),
        source = path.join(scratch, "legacy"),
        destination = path.join(scratch, "new"),
        destinationTarget = "../initialized.md";
      let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
      try {
        unfamiliarDocumentFixture(source);
        initRepo(destination);
        const directory = path.join(destination, "harness/field-notes/2024"),
          target = path.join(directory, "xyz.md");
        mkdirSync(directory, { recursive: true });
        symlinkSync(destinationTarget, target);
        git(destination, "add", ".");
        git(destination, "commit", "-qm", "initialized link");
        cell = await openRepoCell({
          repoId: workspaceId("migration-file-over-link"),
          rootDir: canonicalRoot(destination),
          ownerId: "migration-daemon",
          now: () => "2026-06-01T00:00:00.000Z",
        });
        const result = (await cell.run(
          {
            kind: "migrate-import",
            sourceRoots: sources(source),
            resolutions: ["harness/field-notes/2024/xyz.md=source"],
          },
          { actor, source: "local" },
        )) as Record<string, unknown>;
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        await waitForFixturePublication(cell, String(result.opId), { actor, source: "local" });
        assert.equal(lstatSync(target).isFile(), true);
        assert.equal(
          readFileSync(target, "utf8"),
          "# Field observation\n\nUnknown directories are ordinary authored content.\n",
        );
        assert.equal(
          readdirSync(directory).some((name) => name.includes(".conflict-")),
          false,
        );
      } finally {
        await cell?.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  test("a destination directory can be kept but cannot be replaced by =source", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-directory-resolution-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      initRepo(destination);
      const target = path.join(destination, "harness/field-notes/2024/xyz.md");
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "kept.md"), "# Kept directory entry\n");
      git(destination, "add", ".");
      git(destination, "commit", "-qm", "directory conflict");
      cell = await openRepoCell({
        repoId: workspaceId("migration-directory-resolution"),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-daemon",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      const unsupported = (await cell.run(
        {
          kind: "migrate-import",
          sourceRoots: sources(source),
          resolutions: ["harness/field-notes/2024/xyz.md=source"],
          dryRun: true,
        },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.equal(unsupported.outcome, "op_rejected");
      assert.equal(unsupported.code, "invalid_migration_resolution");
      assert.deepEqual(unsupported.diagnostic, { kind: "failure", code: "invalid_migration_resolution" });
      const kept = (await cell.run(
        {
          kind: "migrate-import",
          sourceRoots: sources(source),
          resolutions: ["harness/field-notes/2024/xyz.md=destination"],
          dryRun: true,
        },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.equal(kept.exitCode, 0, JSON.stringify(kept));
      assert.match(String(kept.summary), /resolved: destination[\s\S]*destination kind=directory/u);
      assert.equal(statSync(target).isDirectory(), true);
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("resolution declarations reject traversal, duplicates, and paths that are not current conflicts", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-invalid-resolution-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      initRepo(destination);
      cell = await openRepoCell({
        repoId: workspaceId("migration-invalid-resolution"),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-daemon",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      const run = (resolutions: readonly string[]) =>
        cell!.run(
          {
            kind: "migrate-import",
            sourceRoots: sources(source),
            resolutions,
            dryRun: true,
          },
          { actor, source: "local" },
        );
      for (const values of [
        ["../outside.md=source"],
        ["harness/field-notes/2024/xyz.md=source", "harness/field-notes/2024/xyz.md=destination"],
        ["harness/field-notes/2024/xyz.md=source"],
      ] as const) {
        const result = (await run(values)) as Record<string, unknown>;
        assert.equal(result.outcome, "op_rejected");
        assert.equal(result.code, "invalid_migration_resolution");
        assert.deepEqual(result.diagnostic, { kind: "failure", code: "invalid_migration_resolution" });
      }
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("resolution cannot bypass a repository document that is semantically uncarryable", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-invalid-content-resolution-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new"),
      relative = "field-notes/2024/xyz.md",
      hash = "a".repeat(64);
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      writeFileSync(
        path.join(source, "harness", relative),
        `${JSON.stringify({ attachment: { store: "authored-cas/v1", ref: `harness/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2)}`, sha256: hash, size: 1, mediaType: "text/plain" } })}\n`,
      );
      initRepo(destination);
      mkdirSync(path.dirname(path.join(destination, "harness", relative)), {
        recursive: true,
      });
      writeFileSync(path.join(destination, "harness", relative), "different\n");
      git(destination, "add", ".");
      git(destination, "commit", "-qm", "conflicting target");
      cell = await openRepoCell({
        repoId: workspaceId("migration-invalid-content-resolution"),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-daemon",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      const required = (await cell.run(
        { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.match(String(required.summary), /referenced CAS blob.*missing/u);
      const rejected = (await cell.run(
        {
          kind: "migrate-import",
          sourceRoots: sources(source),
          resolutions: [`harness/${relative}=source`],
          dryRun: true,
        },
        { actor, source: "local" },
      )) as Record<string, unknown>;
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, "invalid_migration_resolution");
      assert.deepEqual(rejected.diagnostic, { kind: "failure", code: "invalid_migration_resolution" });
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

// Fragment from migration-import-rosters-multisource.integration.test.ts: opened the bootstrapped
// repo-cell fixture.
{
  const openRepoCell = openBootstrappedRepoCell;
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
      await cell.settlePendingMaterialization("inspect imported roster");
      assert.match(
        String(result.summary),
        /\| people-registry \| migrated \| 1 \| PASS \| unioned both rosters into the destination: 2 people \(1 carried from the source: person_dingwen, 1 enriched in place: person_zeyu\), 1 roles \(0 carried from the source\) \|/u,
      );
      const roster = peopleRosterFromDocument(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"));
      assert.deepEqual(
        roster.people.map(({ personId }) => personId),
        ["person_zeyu", "person_dingwen"],
      );
      assert.equal(roster.people[0]!.primaryEmail, "lizeyu990625@gmail.com");
      assert.deepEqual([...roster.people[0]!.credentials], [...bootstrapPerson.credentials]);
      await cell.close();
      cell = undefined;
      const event = makeTaskEventReader({
        repoId: "migration-people-union",
        rootDir: destination,
      })
        .read()
        .events.find((candidate) => candidate.schema === "people-event/v1")!;
      assert.equal(event.schema, "people-event/v1");
      if (event.schema === "people-event/v1") {
        assert.equal(event.payload.action, "people-reconcile");
        assert.equal(event.payload.baseDocumentSha256, sha256Text(bootstrapRoster()));
      }
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a roster the destination already covers is reported as covered rather than rewritten", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-people-covered-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      writeFileSync(path.join(source, "harness/people.yaml"), legacyRoster.replace(/^ +primaryEmail:.*\n/mu, ""));
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
      const before = readFileSync(path.join(destination, "harness/people.yaml"), "utf8");
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
      assert.equal(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"), before);
      assert.equal(
        makeTaskEventReader({
          repoId: "migration-people-covered",
          rootDir: destination,
        })
          .read()
          .events.some((event) => event.schema === "people-event/v1"),
        false,
      );
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("rosters that genuinely contradict still stop, name the contradiction, and keep the explicit resolution", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-people-contradiction-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      unfamiliarDocumentFixture(source);
      writeFileSync(
        path.join(source, "harness/people.yaml"),
        legacyRoster.replace('displayName: "Zeyu Li"\n    primaryEmail', 'displayName: "Li Zeyu"\n    primaryEmail'),
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
      await cell.settlePendingMaterialization("inspect resolved roster");
      assert.equal(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"), bootstrapRoster());
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
      await cell.settlePendingMaterialization("inspect multi-source import");
      assert.match(String(result.summary), /Migration import batch \(2\/2 sources processed\)/u);
      assert.match(String(result.summary), /REMAP task task_shared -> task_shared__[0-9a-f]{10}/u);
      assert.match(String(result.summary), /REMAP decision dec_SHARED -> dec_SHARED__[0-9a-f]{10}/u);
      const events = makeTaskEventReader({
          repoId: "migration-multi-source-target",
          rootDir: destination,
        })
          .read()
          .events.filter((event) => event.schema === "migration-import-event/v1"),
        tasks = events.filter(
          (event) => event.payload.entity.kind === "task" && event.payload.migratedFrom === "task_shared",
        ),
        decisions = events.filter(
          (event) => event.payload.entity.kind === "decision" && event.payload.migratedFrom === "dec_SHARED",
        );
      assert.equal(tasks.length, 2);
      assert.equal(new Set(tasks.map(({ opId }) => opId)).size, 2);
      assert.deepEqual(
        tasks.map((event) => (event.payload.entity.kind === "task" ? event.payload.entity.task.taskId : "")).sort(),
        [
          "task_shared",
          tasks
            .map((event) => (event.payload.entity.kind === "task" ? event.payload.entity.task.taskId : ""))
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
            JSON.parse(readFileSync(path.join(destination, "harness/migrations", String(entry)), "utf8")) as {
              readonly sourceGit: { readonly rootCommit: string };
              readonly remappings: readonly {
                readonly entityType: string;
                readonly sourceId: string;
                readonly targetId: string;
              }[];
            },
        );
      assert.equal(maps.length, 2);
      assert.equal(new Set(maps.map(({ sourceGit }) => sourceGit.rootCommit)).size, 2);
      assert.equal(
        maps
          .flatMap(({ remappings }) => remappings)
          .some(
            ({ entityType, sourceId, targetId }) =>
              entityType === "task" && sourceId === "task_shared" && targetId.startsWith("task_shared__"),
          ),
        true,
      );
      const roster = peopleRosterFromDocument(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"));
      assert.deepEqual(
        roster.people.map(({ personId }) => personId),
        ["person_zeyu", "person_alpha", "person_beta"],
      );
      assert.equal(
        makeTaskEventReader({
          repoId: "migration-multi-source-target",
          rootDir: destination,
        })
          .read()
          .events.filter((event) => event.schema === "people-event/v1").length,
        2,
      );
      const revision = result.revision,
        repeated = (await cell.run(
          { kind: "migrate-import", sourceRoots: [firstSource, secondSource] },
          { actor, source: "local" },
        )) as Record<string, unknown>;
      assert.equal(repeated.exitCode, 0, JSON.stringify(repeated));
      assert.equal(repeated.revision, revision, JSON.stringify(repeated));
      assert.match(
        String(repeated.summary),
        /Already imported from this Git lineage: task=1, decision=1, fact=1, relation=2/u,
      );
      await cell.close();
      cell = undefined;
      const store = makeTaskEventReader({
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
      assert.equal(digest(path.join(scratch, "cold-one.sqlite")), digest(path.join(scratch, "cold-two.sqlite")));
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("migration rejects dirty, shallow, and multi-root Git sources before any event write", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-git-validation-")),
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
      const initialRevision = makeTaskEventReader({
        repoId: "migration-git-validation",
        rootDir: destination,
      }).read().revision;
      writeFileSync(path.join(source, "uncommitted.txt"), "not part of the source cut\n");
      const dirty = await cell.run({ kind: "migrate-import", sourceRoots: [source] }, { actor, source: "local" });
      assert.equal(dirty.outcome, "op_rejected");
      assert.equal(dirty.code, "invalid_migration_source_git");
      assert.equal(
        makeTaskEventReader({
          repoId: "migration-git-validation",
          rootDir: destination,
        }).readHead()?.revision ?? 0,
        initialRevision,
      );
      rmSync(path.join(source, "uncommitted.txt"));
      execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source}`, shallow]);
      const rejected = await cell.run({ kind: "migrate-import", sourceRoots: [shallow] }, { actor, source: "local" });
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, "invalid_migration_source_git");
      const unrelatedRoot = git(source, "commit-tree", git(source, "rev-parse", "HEAD^{tree}"), "-m", "unrelated root");
      git(source, "merge", "-q", "--allow-unrelated-histories", unrelatedRoot, "-m", "merge unrelated root");
      const split = await cell.run({ kind: "migrate-import", sourceRoots: [source] }, { actor, source: "local" });
      assert.equal(split.outcome, "op_rejected");
      assert.equal(split.code, "invalid_migration_source_git");
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
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

// Fragment from migration-import-acceptance.integration.test.ts: opened the bootstrapped repo-cell
// fixture.
{
  const openRepoCell = openBootstrappedRepoCell;
  test("migration import commits its prepared members and terminal outcome atomically", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-import-acceptance-")),
      source = path.join(scratch, "legacy"),
      secondSource = path.join(scratch, "legacy-second"),
      thirdSource = path.join(scratch, "legacy-third"),
      rootDir = path.join(scratch, "repo"),
      repoId = workspaceId("migration-import-acceptance"),
      binding = { actor, source: "local" as const };
    let armed = false,
      first: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      retry: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      coverageCompleteFixture(source);
      coverageCompleteFixture(secondSource);
      coverageCompleteFixture(thirdSource);
      writeFileSync(path.join(source, "harness/source-alpha.txt"), "alpha source identity\n");
      writeFileSync(path.join(secondSource, "harness/source-beta.txt"), "beta source identity\n");
      writeFileSync(path.join(thirdSource, "harness/source-gamma.txt"), "gamma source identity\n");
      const firstSources = sources(source),
        secondSources = sources(secondSource),
        firstRoot = execFileSync("git", ["-C", source, "rev-list", "--max-parents=0", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        secondRoot = execFileSync("git", ["-C", secondSource, "rev-list", "--max-parents=0", "HEAD"], {
          encoding: "utf8",
        }).trim();
      assert.notEqual(firstRoot, secondRoot);
      const thirdSources = sources(thirdSource);
      execFileSync("git", ["-C", thirdSource, "commit", "--allow-empty", "-m", "distinct third source"]);
      initRepo(rootDir);
      const action = { kind: "migrate-import" as const, sourceRoots: [...firstSources, ...secondSources] };
      first = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "migration-import-first",
        killpoint: (point) => {
          if (armed && point === "after_event_write") throw new Error("stop before import outcome");
        },
      });
      const before = makeTaskEventReader({ repoId, rootDir }),
        originalEvents = before.read().events,
        originalRevision = before.read().revision;
      await before.drain();
      armed = true;
      const failed = await first.run(action, binding);
      armed = false;
      assert.equal(failed.outcome, "op_rejected", JSON.stringify(failed));
      const rolledBack = makeTaskEventReader({ repoId, rootDir });
      assert.equal(rolledBack.read().revision, originalRevision);
      assert.deepEqual(rolledBack.read().events, originalEvents);
      assert.equal(rolledBack.readCommandOutcome(failed.opId), null);
      await rolledBack.drain();

      await first.close();
      first = undefined;
      retry = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "migration-import-retry",
      });
      const accepted = await retry.run(action, binding);
      assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));
      const committed = makeTaskEventReader({ repoId, rootDir }),
        outcome = committed.readCommandOutcome(accepted.opId)!;
      assert.equal(outcome.status, "accepted_durable");
      assert.ok(outcome.memberOpIds.length > 2, JSON.stringify(outcome));
      assert.equal(outcome.firstRevision, originalRevision + 1);
      assert.equal(outcome.lastRevision, originalRevision + outcome.memberOpIds.length);
      assert.equal(committed.read().revision, outcome.lastRevision);
      assert.equal(accepted.acceptance?.revisionFrom, outcome.firstRevision);
      assert.equal(accepted.acceptance?.revisionTo, outcome.lastRevision);
      assert.deepEqual(accepted.acceptance?.memberOpIds, outcome.memberOpIds);
      assert.equal(
        committed.read().events.filter(({ opId }) => outcome.memberOpIds.includes(opId)).length,
        outcome.memberOpIds.length,
      );
      assert.equal(
        committed
          .read()
          .events.filter(
            (event) =>
              outcome.memberOpIds.includes(event.opId) &&
              event.schema === "migration-import-event/v1" &&
              event.payload.entity.kind === "task",
          ).length,
        2,
      );
      await committed.drain();
      const priorRevision = outcome.lastRevision!,
        mixedAction = { kind: "migrate-import" as const, sourceRoots: [...thirdSources, ...sources(secondSource)] },
        trailingNoop = await retry.run(mixedAction, binding);
      assert.equal(trailingNoop.status, "accepted_durable", JSON.stringify(trailingNoop));
      assert.ok(trailingNoop.acceptance!.revisionFrom > priorRevision);
      assert.equal(trailingNoop.acceptance!.revisionTo, trailingNoop.revision);
      assert.equal(trailingNoop.acceptance!.memberOpIds.at(-1), trailingNoop.opId);
      const noChanges = await retry.run(mixedAction, binding),
        repeatedNoChanges = await retry.run(mixedAction, binding);
      assert.equal(noChanges.outcome, "no_changes");
      assert.equal(noChanges.acceptance, null);
      assert.equal(noChanges.opId, repeatedNoChanges.opId);
    } finally {
      await first?.close();
      await retry?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
