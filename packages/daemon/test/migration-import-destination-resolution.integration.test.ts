// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveRelationId,
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
  attributionFixture,
  binaryAttachmentFixture,
  bootstrapPerson,
  bootstrapRoster,
  coverageCompleteFixture,
  coverageGapFixture,
  decisionContentFixture,
  git,
  hierarchyFixture,
  illegalRelationFixture,
  initRepo,
  legacyFixture,
  legacyRoster,
  multiSourceFixture,
  orphanEndpointFixture,
  referencedDocumentFixture,
  snapshot,
  sources,
  statOrNull,
  symbolicLinkFixture,
  unfamiliarDocumentFixture,
} from "./migration-import.fixtures.ts";
test("a different destination document at the same path requires a decision and reports both sides", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-conflict-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    sourceBody =
      "# Field observation\n\nUnknown directories are ordinary authored content.\n",
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
    assert.match(
      String(result.summary),
      /REQUIRED field-notes\/2024\/xyz\.md/u,
    );
    assert.match(
      String(result.summary),
      new RegExp(
        `source sha256=${sha256Text(sourceBody)}.*destination sha256=${sha256Text(destinationBody)}`,
        "u",
      ),
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
    assert.equal(
      (preview.proof as { readonly canonicalVisible: boolean })
        .canonicalVisible,
      false,
    );
    assert.match(String(preview.summary), /resolved: source/u);
    assert.equal(
      makeTaskEventStore({
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
    assert.equal(readFileSync(target, "utf8"), sourceBody);
    assert.equal(
      readdirSync(path.dirname(target)).some((name) =>
        name.includes(".conflict-"),
      ),
      false,
    );
    const event = makeTaskEventStore({
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
    assert.deepEqual(
      (event.payload.entity as { readonly destinationPreimage?: unknown })
        .destinationPreimage,
      {
        nodeKind: "file",
        sha256: sha256Text(destinationBody),
        size: Buffer.byteLength(destinationBody),
      },
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("destination resolution keeps the visible target and explicitly accounts for the discarded source", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-destination-resolution-"),
    ),
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
    writeFileSync(
      path.join(source, "harness/field-notes/2024/xyz.md"),
      sourceBody,
    );
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
    assert.equal(readFileSync(target, "utf8"), destinationBody);
    assert.match(
      String(result.summary),
      /\| field-notes\/2024\/xyz\.md \| excluded \| 1 \| PASS \| resolved: destination; discarded source kind=file, source sha256=[0-9a-f]{64}, source bytes=9; kept destination kind=file, destination sha256=[0-9a-f]{64}, destination bytes=14 \|/u,
    );
    assert.equal(
      makeTaskEventStore({
        repoId: "migration-destination-resolution",
        rootDir: destination,
      })
        .read()
        .events.some(
          (event) =>
            event.schema === "migration-import-event/v1" &&
            event.payload.migratedFrom === "field-notes/2024/xyz.md",
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
    skip:
      process.platform === "win32"
        ? "requires POSIX file-symbolic-link semantics"
        : false,
  },
  async () => {
    const scratch = mkdtempSync(
        path.join(tmpdir(), "ha-migrate-link-resolution-"),
      ),
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
      assert.equal(readlinkSync(target), sourceTarget);
      assert.equal(
        readdirSync(directory).some((name) => name.includes(".conflict-")),
        false,
      );
      assert.match(
        String(result.summary),
        /resolved: source; kept source kind=symbolic-link[\s\S]*source link target="\.\.\/legacy\.md"[\s\S]*destination link target="\.\.\/initialized\.md"/u,
      );
      const event = makeTaskEventStore({
        repoId: "migration-link-resolution",
        rootDir: destination,
      })
        .read()
        .events.find(
          (candidate) =>
            candidate.schema === "migration-import-event/v1" &&
            candidate.payload.migratedFrom === "field-notes/latest.md",
        )!;
      assert.deepEqual(
        (event.payload.entity as { readonly destinationPreimage?: unknown })
          .destinationPreimage,
        {
          nodeKind: "symbolic-link",
          sha256: sha256Text(destinationTarget),
          size: Buffer.byteLength(destinationTarget),
        },
      );
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "source resolution can replace a committed destination link with a regular file",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX file-symbolic-link semantics"
        : false,
  },
  async () => {
    const scratch = mkdtempSync(
        path.join(tmpdir(), "ha-migrate-file-over-link-"),
      ),
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
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-directory-resolution-"),
    ),
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
    assert.match(
      String(unsupported.nextAction),
      /is a directory; =source cannot replace a directory node.*manually.*dry-run/iu,
    );
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
    assert.match(
      String(kept.summary),
      /resolved: destination[\s\S]*destination kind=directory/u,
    );
    assert.equal(statSync(target).isDirectory(), true);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("resolution declarations reject traversal, duplicates, and paths that are not current conflicts", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-invalid-resolution-"),
    ),
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
    for (const [values, pattern] of [
      [["../outside.md=source"], /normalized repository-relative path/u],
      [
        [
          "harness/field-notes/2024/xyz.md=source",
          "harness/field-notes/2024/xyz.md=destination",
        ],
        /Duplicate --resolve path/u,
      ],
      [
        ["harness/field-notes/2024/xyz.md=source"],
        /is not currently a destination conflict/u,
      ],
    ] as const) {
      const result = (await run(values)) as Record<string, unknown>;
      assert.equal(result.outcome, "op_rejected");
      assert.match(String(result.nextAction), pattern);
    }
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("resolution cannot bypass a repository document that is semantically uncarryable", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-invalid-content-resolution-"),
    ),
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
    assert.match(
      String(rejected.nextAction),
      /not currently a destination conflict/u,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
