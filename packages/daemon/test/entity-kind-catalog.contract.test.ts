// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEntityKindCatalog, validateEntityKindCatalog } from "../../kernel/src/index.ts";
import {
  compiledArtifactKinds,
  relationDirectionRegistry,
  resolveEntityReadKind,
} from "../src/artifact-entity-action.ts";
import { readDeclaredEntityRows, validateEntityRowList } from "../src/entity-rows-read.ts";
import { readEntityLocator, validateEntityLocatorRead } from "../src/entity-locator-read.ts";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";

const ADR_KIND = "software/coding/architecture-decision-record@1",
  RESEARCH_KIND = "software/coding/research@1",
  repositoryRoot = mkdtempSync(path.join(tmpdir(), "ha-vertical-catalog-"));
mkdirSync(path.join(repositoryRoot, "harness"), { recursive: true });
writeFileSync(
  path.join(repositoryRoot, "harness", "vertical.json"),
  JSON.stringify({
    schema: "repository-vertical-declaration/v1",
    revision: 1,
    definition: JSON.parse(readFileSync(path.join(defaultAssets, "vertical.json"), "utf8")),
  }),
);
test.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
const repositoryKinds = () => compiledArtifactKinds(repositoryRoot, "catalog-contract");

/**
 * 已注册 kind 读面的契约:GUI 的实体种类集合只能从这里来。
 *
 * 两条不变量:内核内建 kind 与 vertical 声明的 kind 出现在**同一份**清单里且各自
 * 带同源解释;声明出来的 kind 用完整 type identity(`<vertical>/<id>@<version>`)——
 * 短名不是它的身份,拿短名去 import 会被拒。
 */
test("entity kind catalog carries builtin and declared kinds through the same explanation", () => {
  const catalog = buildEntityKindCatalog(repositoryKinds(), 1);
  assert.equal(catalog.declarationRevision, 1);
  assert.deepEqual(validateEntityKindCatalog(catalog), []);

  const builtin = catalog.kinds.filter(({ origin }) => origin === "builtin");
  const declared = catalog.kinds.filter(({ origin }) => origin === "vertical");
  assert.ok(
    builtin.some(({ kind }) => kind === "task"),
    "task must be in the catalog",
  );
  assert.ok(
    builtin.some(({ kind }) => kind === "decision"),
    "decision must be in the catalog",
  );
  assert.ok(declared.length > 0, "the bundled vertical declares at least one artifact kind");

  for (const row of catalog.kinds) {
    assert.equal(row.explanation.schema, "entity-kind-explanation/v1");
    assert.equal(row.explanation.kind, row.kind);
    assert.equal(row.refTemplate, `${row.kind}/{id}`);
    assert.ok(row.explanation.documentSchema.fields.length > 0, `${row.kind} must explain its fields`);
  }
});

test("the declared ADR kind is addressed by its full type identity and is importable", () => {
  const catalog = buildEntityKindCatalog(repositoryKinds(), 1);
  const adr = catalog.kinds.find(({ kind }) => kind === ADR_KIND);
  assert.ok(adr, `catalog must carry ${ADR_KIND}`);
  assert.equal(adr.origin, "vertical");
  assert.equal(adr.verticalId, "software/coding");
  assert.equal(adr.importable, true, "an artifact kind with an executable import action is creatable");
  assert.equal(adr.declaration?.idPrefix, "ADR");
  assert.deepEqual(adr.declaration?.locatorKinds, ["repository-path"]);
  // 短名不是身份:目录里不得出现它,否则 GUI 会拿它去调 import 然后被拒。
  assert.equal(
    catalog.kinds.some(({ kind }) => kind === "architecture-decision-record"),
    false,
  );
});

test("the declared research kind is importable and carries both governed relation directions", () => {
  const catalog = buildEntityKindCatalog(repositoryKinds(), 1),
    research = catalog.kinds.find(({ kind }) => kind === RESEARCH_KIND);
  assert.ok(research, `catalog must carry ${RESEARCH_KIND}`);
  assert.equal(research.importable, true);
  assert.equal(research.declaration?.idPrefix, "RES");
  assert.equal(research.declaration?.pathTemplate, "entities/research/{id}.json");
  assert.deepEqual(research.declaration?.locatorKinds, ["repository-path"]);
  assert.deepEqual(
    relationDirectionRegistry(repositoryRoot, "catalog-contract")
      .filter(({ sourceKind }) => sourceKind === RESEARCH_KIND)
      .map(({ type, sourceKind, targetKind }) => ({ type, sourceKind, targetKind })),
    [
      { type: "relates", sourceKind: RESEARCH_KIND, targetKind: "decision" },
      { type: "relates", sourceKind: RESEARCH_KIND, targetKind: "task" },
    ],
  );
});

test("entity projection reads resolve vertical declaration ids to canonical kind identities", () => {
  const kinds = repositoryKinds();
  assert.equal(resolveEntityReadKind("architecture-decision-record", kinds), ADR_KIND);
  assert.equal(resolveEntityReadKind("external-issue", kinds), "software/coding/external-issue@1");
  assert.equal(resolveEntityReadKind("research", kinds), RESEARCH_KIND);
  assert.equal(resolveEntityReadKind(RESEARCH_KIND, kinds), RESEARCH_KIND);
  assert.equal(resolveEntityReadKind("agent", kinds), "agent");
});

test("builtin rows carry no declaration and declared rows always do", () => {
  const catalog = buildEntityKindCatalog(repositoryKinds(), 1);
  for (const row of catalog.kinds)
    assert.equal(row.declaration === null, row.origin === "builtin", `${row.kind} declaration presence`);
});

/** 阴性对照:vertical 不声明 artifact kind 时,目录里只剩内建 kind——清单确实来自声明。 */
test("a vertical with no declared artifact kind yields a builtin-only catalog", () => {
  const catalog = buildEntityKindCatalog([], 1);
  assert.deepEqual(validateEntityKindCatalog(catalog), []);
  assert.equal(
    catalog.kinds.every(({ origin }) => origin === "builtin"),
    true,
  );
  assert.equal(
    catalog.kinds.some(({ kind }) => kind === ADR_KIND),
    false,
  );
});

test("entity rows only project declared kinds and keep canonical refs", () => {
  const catalog = buildEntityKindCatalog(repositoryKinds(), 1);
  const listed: string[] = [];
  const rows = readDeclaredEntityRows({
    catalog,
    projection: {
      listEntities: (kind: string) => {
        listed.push(kind);
        return kind === ADR_KIND
          ? [
              {
                kind,
                id: "ADR-0123456789abcdef",
                ownerId: null,
                workspaceRevision: 42,
                freshness: "current" as const,
                currentVersion: null,
                value: {
                  title: "ADR-0020 · Decision 与 ADR 边界",
                  locator: { kind: "repository-path", value: "harness/adr/ADR-0020.md" },
                },
              },
            ]
          : [];
      },
    },
  });
  assert.deepEqual(validateEntityRowList(rows), []);
  assert.equal(
    listed.includes("task"),
    false,
    "builtin kinds have their own read surfaces; this one must not duplicate them",
  );
  assert.deepEqual(rows.rows, [
    {
      kind: ADR_KIND,
      entityId: "ADR-0123456789abcdef",
      ref: `${ADR_KIND}/ADR-0123456789abcdef`,
      title: "ADR-0020 · Decision 与 ADR 边界",
      locator: { kind: "repository-path", value: "harness/adr/ADR-0020.md" },
      revision: 42,
      archived: false,
    },
  ]);
});

test("entity rows include daemon-local runtime instances with Provider deep links", () => {
  const rows = readDeclaredEntityRows({
    catalog: buildEntityKindCatalog([], 1),
    projection: { listEntities: () => [] },
    runtimeInstances: () => [
      {
        schemaVersion: 2,
        instanceId: "codex-sol",
        name: "Codex Sol",
        kindId: "codex",
        installationId: "codex-installation",
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        permissionMode: "workspace-write",
        authMode: "subscription",
        authState: "authenticated",
        authReadiness: { status: "ready", code: null, hint: null },
        isolationState: "enforced",
        configuration: {},
      },
    ],
  });
  assert.deepEqual(rows.rows, [
    {
      kind: "runtime-instance",
      entityId: "codex-sol",
      ref: "runtime-instance/codex-sol",
      title: "Codex Sol",
      locator: { kind: "entity-ref", value: "provider/codex-sol" },
      revision: 0,
      archived: false,
    },
  ]);
});

test("entity rows remain available when daemon-local runtime inventory is unreadable", () => {
  const rows = readDeclaredEntityRows({
    catalog: buildEntityKindCatalog([], 1),
    projection: { listEntities: () => [] },
    runtimeInstances: () => {
      throw new Error("unreadable runtime inventory fixture");
    },
  });
  assert.deepEqual(rows, { schema: "entity-row-list/v1", ok: true, rows: [] });
});

test("locator read serves repo files and directories and refuses to escape the root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "entity-locator-"));
  try {
    mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
    writeFileSync(path.join(root, "docs", "note.md"), "# 标题\n正文\n", "utf8");
    writeFileSync(path.join(root, "docs", "nested", "inner.md"), "inner\n", "utf8");

    const file = readEntityLocator({ rootDir: root, locatorKind: "repository-path", locatorValue: "docs/note.md" });
    assert.deepEqual(validateEntityLocatorRead(file), []);
    assert.equal(file.outcome, "file");
    assert.equal(file.content, "# 标题\n正文\n");

    const dir = readEntityLocator({ rootDir: root, locatorKind: "repository-path", locatorValue: "docs" });
    assert.deepEqual(validateEntityLocatorRead(dir), []);
    assert.equal(dir.outcome, "directory");
    assert.deepEqual(dir.entries.map(({ path: entryPath }) => entryPath).sort(), ["docs/nested", "docs/note.md"]);

    const missing = readEntityLocator({ rootDir: root, locatorKind: "repository-path", locatorValue: "docs/gone.md" });
    assert.equal(missing.outcome, "missing");

    const external = readEntityLocator({ rootDir: root, locatorKind: "url", locatorValue: "https://example.com/a" });
    assert.equal(external.outcome, "unsupported");

    const oversize = readEntityLocator({
      rootDir: root,
      locatorKind: "repository-path",
      locatorValue: "docs/note.md",
      maxBytes: 1,
    });
    assert.equal(oversize.outcome, "too-large");
    assert.equal(oversize.content, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vertical declaration and entity reads are registered on the closed GUI read surface", () => {
  for (const [method, id, bridge] of [
    ["repo.vertical.declaration.read", "vertical.declaration.read", "readVerticalDeclaration"],
    ["repo.entity.kinds.read", "entity.kinds.read", "readEntityKinds"],
    ["repo.entity.rows.read", "entity.rows.read", "readEntityRows"],
    ["repo.entity.locator.read", "entity.locator.read", "readEntityLocator"],
  ] as const) {
    const entry = daemonGuiReadMethods.find((candidate) => candidate.method === method);
    assert.ok(entry, `${method} must be registered`);
    assert.equal(entry.id, id);
    assert.equal(entry.guiBridgeMethod, bridge);
    assert.equal(entry.commandClass, "repo-read");
    assert.equal(entry.requiresRepo, true);
  }
  validateDaemonRpcCall("repo.vertical.declaration.read", { repo: { repoId: "canonical" } });
  validateDaemonRpcCall("repo.entity.kinds.read", { repo: { repoId: "canonical" } });
  validateDaemonRpcCall("repo.entity.rows.read", { repo: { repoId: "canonical" } });
  validateDaemonRpcCall("repo.entity.locator.read", {
    repo: { repoId: "canonical" },
    payload: { locatorKind: "repository-path", locatorValue: "docs/note.md" },
  });
});

test("gui result validation rejects a catalog whose declared row lost its declaration", () => {
  const catalog = buildEntityKindCatalog(repositoryKinds(), 1);
  const broken = {
    ...catalog,
    kinds: catalog.kinds.map((row) => (row.origin === "vertical" ? { ...row, declaration: null } : row)),
  };
  assert.throws(() => parseDaemonGuiReadResult("repo.entity.kinds.read", broken));
});
