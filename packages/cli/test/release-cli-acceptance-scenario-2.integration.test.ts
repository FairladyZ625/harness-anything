// harness-test-tier: integration
import test from "node:test";
import * as shared from "./release-cli-acceptance.fixture.ts";

const {
  assert,
  execFileSync,
  spawnSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  hostname,
  tmpdir,
  path,
  makeTaskEventReader,
  sha256Bytes,
  seedSettingsEvent,
  realizedPlan,
  cli,
  daemonId,
  initialize,
  git,
  gitBytes,
  gitHasPath,
  environment,
  startDaemon,
  run,
  runMaybe,
  runOffline,
  settle,
  writeCloseout,
  docStatusRows,
} = shared;

test("release acceptance: a fresh custom Artifact kind runs its file/folder lifecycle with Git-bound publication", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-release-acc-entity-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "release-acc-entity",
    customKind = "release-runbook";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId });
  const reader = makeTaskEventReader({ rootDir: root, repoId });
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]);
    // A manually initialized fixture has no vertical declaration yet; the supported CLI materializes it.
    run(root, userRoot, ["migrate", "vertical-declaration"]);
    const kindDeclaration = {
      id: customKind,
      entityType: "artifact",
      idPrefix: "RLB",
      display: { singular: "Release Runbook", plural: "Release Runbooks" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: "entities/release-runbooks/{id}.json" },
      locatorKinds: ["repository-path"],
    };
    writeFileSync(path.join(root, "release-runbook-kind.json"), JSON.stringify(kindDeclaration));
    const upserted = run(root, userRoot, [
      "vertical",
      "entity-kind",
      "upsert",
      "--from-file",
      "release-runbook-kind.json",
    ]);
    assert.ok(String(upserted.opId ?? "").length > 0, `upsert must be accepted: ${JSON.stringify(upserted)}`);
    // The write surface addresses a kind by its stable opaque ref; the read surface also accepts the id.
    const kindRef = (JSON.parse(String(upserted.evidence)) as { kindRef: string }).kindRef;
    assert.match(kindRef, /^entity-kind\/KND-[a-f0-9]{32}$/u, String(upserted.evidence));
    context.diagnostic(`release-acc-kind-upsert=${JSON.stringify(upserted)}`);

    const sourcePath = "release-acc-sources/deploy-guide",
      absoluteSource = path.join(root, sourcePath),
      readmeBytes = "# Deploy guide\n\nRelease acceptance custom-kind material.\n",
      dataBytes = Buffer.from(`${JSON.stringify({ service: "edge", replicas: 2 }, null, 2)}\n`),
      binaryBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x7f]);
    mkdirSync(path.join(absoluteSource, "blobs"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "reserved"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), readmeBytes);
    writeFileSync(path.join(absoluteSource, "data.json"), dataBytes);
    writeFileSync(path.join(absoluteSource, "blobs", "binary.bin"), binaryBytes);
    git(root, "add", sourcePath);
    git(root, "commit", "--quiet", "-m", "custom kind source");

    const imported = run(root, userRoot, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
    ]);
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const entityId = (JSON.parse(String(imported.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.match(entityId, /^RLB-[a-f0-9]{32}$/u, entityId);
    const settledImport = settle(root, userRoot, String(imported.opId));
    assert.equal((settledImport.git as { state: string }).state, "verified");
    assert.equal((settledImport.worktree as { state: string }).state, "verified");
    const contentRoot = `entities/release-runbooks/${entityId}`,
      held = (...segments: readonly string[]) => path.join(root, "harness", contentRoot, ...segments),
      importCommit = git(root, "rev-parse", "HEAD");
    assert.equal(readFileSync(held("README.md"), "utf8"), readmeBytes);
    assert.deepEqual(readFileSync(held("data.json")), dataBytes);
    assert.deepEqual(readFileSync(held("blobs", "binary.bin")), binaryBytes);
    assert.ok(statSync(held("reserved")).isDirectory(), "the empty directory must come back");
    assert.deepEqual(gitBytes(root, `HEAD:harness/${contentRoot}/blobs/binary.bin`), binaryBytes);
    assert.deepEqual(gitBytes(root, `HEAD:harness/${contentRoot}/README.md`), Buffer.from(readmeBytes));

    const retry = run(root, userRoot, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
    ]);
    assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));
    assert.equal(retry.opId, imported.opId, "a retry resolves through the source binding");

    const listed = run(root, userRoot, ["entity", "list", customKind]),
      listEvidence = JSON.parse(String(listed.evidence)) as {
        kind: string;
        entities: ReadonlyArray<{ id: string }>;
      },
      entities = listEvidence.entities;
    assert.equal(listEvidence.kind, kindRef, "the read surface resolves the display id to the stable kind");
    assert.ok(
      entities.some(({ id }) => id === entityId),
      JSON.stringify(entities),
    );
    const got = run(root, userRoot, ["entity", "get", customKind, "--id", entityId]),
      descriptor = (JSON.parse(String(got.evidence)) as { entity: { value?: { locator?: { value?: string } } } })
        .entity;
    assert.equal(descriptor.value?.locator?.value, sourcePath, JSON.stringify(descriptor));

    // The source goes away on disk and in Git; owned content must survive from the ledger alone.
    rmSync(absoluteSource, { recursive: true, force: true });
    git(root, "add", "-A", sourcePath);
    git(root, "commit", "--quiet", "-m", "remove the imported source");
    assert.deepEqual(readFileSync(held("blobs", "binary.bin")), binaryBytes);
    assert.deepEqual(readFileSync(held("README.md")), Buffer.from(readmeBytes));

    const importedRevision = Number(imported.revision),
      updated = run(root, userRoot, [
        "entity",
        "update",
        kindRef,
        "--id",
        entityId,
        "--expected-version",
        String(importedRevision),
        "--title",
        "Release runbook, retitled",
      ]);
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    settle(root, userRoot, String(updated.opId));
    const descriptorFile = path.join(root, "harness", `${contentRoot}.json`);
    assert.match(readFileSync(descriptorFile, "utf8"), /Release runbook, retitled/u);

    const stale = runMaybe(root, userRoot, [
      "entity",
      "update",
      kindRef,
      "--id",
      entityId,
      "--expected-version",
      String(importedRevision),
      "--title",
      "Stale fence",
    ]);
    assert.notEqual(stale.status, 0, "a stale fence must be refused");
    assert.equal((JSON.parse(stale.stdout) as { code?: string }).code, "revision_conflict", stale.stdout);

    const deleted = run(root, userRoot, [
      "entity",
      "delete",
      kindRef,
      "--id",
      entityId,
      "--reason",
      "release acceptance retirement",
      "--expected-version",
      String(updated.revision),
    ]);
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    settle(root, userRoot, String(deleted.opId));
    assert.equal(existsSync(descriptorFile), false);
    assert.equal(existsSync(held("README.md")), false);
    assert.equal(existsSync(held("blobs", "binary.bin")), false);
    // Original historical content stays recoverable: Git history and the ledger's own objects.
    assert.deepEqual(gitBytes(root, `${importCommit}:harness/${contentRoot}/blobs/binary.bin`), binaryBytes);
    const importEvent = reader.readEvent(String(imported.opId)),
      manifest =
        importEvent?.schema === "entity-event/v1"
          ? (importEvent.payload.ownedContent as {
              bindings: readonly { path: string; contentSha256: string }[];
            })
          : null;
    assert.ok(manifest, "the import must have left its owned-content manifest");
    const binaryBinding = manifest.bindings.find(({ path: bound }) => bound === `${contentRoot}/blobs/binary.bin`);
    assert.ok(binaryBinding, JSON.stringify(manifest.bindings));
    assert.deepEqual(Buffer.from(reader.readContentBlob(binaryBinding.contentSha256) ?? []), binaryBytes);
    context.diagnostic(JSON.stringify({ schema: "release-acceptance-entity/v1", customKind, entityId }));
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    await reader.drain();
    rmSync(parent, { recursive: true, force: true });
  }
});
