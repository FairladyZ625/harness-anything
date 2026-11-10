// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkBypassWriteBoundary as runBoundaryCheck, scanBypassWriteCalls } from "./check-bypass-write-boundary.mjs";
import { auditCacheDriverImports, cacheDriverAdapterCandidates } from "./gates/cache-driver-import-boundary.mjs";

const checkBypassWriteBoundary = (root, options) => runBoundaryCheck(root, { nonStateIoDeclarations: [], ...options });

function fixture(body, relativePath = "packages/demo/src/state-writer.ts") {
  const root = mkdtempSync(path.join(tmpdir(), "state-residency-gate-"));
  mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  writeFileSync(path.join(root, relativePath), body, "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test("classifies PostgreSQL DDL separately from SQLite helper tables", () => {
  const root = fixture(
    [
      "import type { PoolClient } from 'pg';",
      "/* @gate-identity state-store/demo.pg */ `CREATE TABLE ha_demo (id text)`;",
    ].join("\n"),
    "packages/storage/src/pg/demo-schema.ts",
  );
  try {
    const finding = scanBypassWriteCalls(root).find(({ kind }) => kind === "table");
    assert.equal(finding?.medium, "postgres-table");
    const result = checkBypassWriteBoundary(root, {
      contracts: [
        {
          kind: "demo",
          stateStores: [
            {
              ...authority("demo.pg", { kind: "postgres-table", table: "ha_demo" }),
              role: "projection",
              source: { kind: "demo", store: "demo.events" },
              freshness: { cursor: "revision" },
              invalidation: "rebuild-on-start",
              reader: "readDemo",
            },
          ],
        },
      ],
      baseline: [],
    });
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const authority = (id, medium) => ({
  id,
  role: "authority",
  residency: "runtime-local",
  medium,
  vocabulary: [],
});

test("rejects an unmarked persistent write and an unknown store identity", () => {
  const root = fixture("import { writeFileSync } from 'node:fs';\nwriteFileSync('state.json', '{}');\n");
  try {
    const unmarked = checkBypassWriteBoundary(root, { contracts: [], baseline: [] });
    assert.equal(unmarked.violations.length, 1);
    assert.match(unmarked.violations[0].message, /unowned persistent write/u);

    writeFileSync(
      path.join(root, "packages/demo/src/state-writer.ts"),
      "import { writeFileSync } from 'node:fs';\n/* @gate-identity state-store/missing.store */ writeFileSync('state.json', '{}');\n",
    );
    execFileSync("git", ["add", "."], { cwd: root });
    const unknown = checkBypassWriteBoundary(root, { contracts: [], baseline: [] });
    assert.match(unknown.violations[0].message, /store id does not resolve/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an unowned table and an unmarked shared-cache constructor", () => {
  const root = fixture(
    ["import { createClient } from 'redis';", "db.exec('CREATE TABLE rogue_rows (id TEXT)');", "createClient();"].join(
      "\n",
    ),
  );
  try {
    const result = checkBypassWriteBoundary(root, { contracts: [], baseline: [] });
    assert.deepEqual(
      result.violations.map(({ kind, message }) => [kind, message]),
      [
        ["table", "unowned persistent table"],
        ["cache", "unowned cross-process cache adapter"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a registered write, table, and shared-cache adapter", () => {
  const root = fixture(
    [
      "import { writeFileSync } from 'node:fs';",
      "import { createClient } from 'redis';",
      "/* @gate-identity state-store/demo.write */ writeFileSync('state.json', '{}');",
      "db.exec(/* @gate-identity state-store/demo.table */ 'CREATE TABLE demo_rows (id TEXT)');",
      "const client = /* @gate-identity state-store/demo.cache */ createClient();",
      "void client;",
    ].join("\n"),
  );
  try {
    const contracts = [
      {
        kind: "demo",
        stateStores: [
          authority("demo.write", { kind: "journal", recordSchema: "demo/v1" }),
          authority("demo.table", { kind: "sqlite-table", table: "demo_rows" }),
          {
            id: "demo.cache",
            role: "replica",
            residency: "runtime-local",
            medium: { kind: "shared-cache", adapter: "redis#createClient" },
            vocabulary: [],
            source: { kind: "demo", store: "demo.write" },
            freshness: { cursor: "revision" },
            invalidation: "rebuild-on-start",
            reader: "readDemoCache",
          },
        ],
      },
    ];
    const result = checkBypassWriteBoundary(root, { contracts, baseline: [] });
    assert.deepEqual(result.violations, []);
    assert.equal(scanBypassWriteCalls(root).filter((finding) => finding.kind === "cache").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a source-bound storage owner only in its registered module and medium", () => {
  const relativePath = "packages/storage/src/store/owned-database.ts";
  const root = fixture(
    [
      "import { DatabaseSync } from 'node:sqlite';",
      "const db = /* @gate-identity state-store/demo.sqlite */ new DatabaseSync('state.db');",
      "/* @gate-identity state-store/demo.sqlite */ db.exec('/* @gate-identity state-store/demo.sqlite */ CREATE TABLE owned_rows (id TEXT)');",
    ].join("\n"),
    relativePath,
  );
  const contracts = (module, kind = "sqlite-database") => [
    {
      kind: "demo",
      stateStores: [
        authority("demo.sqlite", { kind, module, ...(kind === "sqlite-database" ? { tables: ["owned_rows"] } : {}) }),
      ],
    },
  ];
  try {
    assert.deepEqual(
      checkBypassWriteBoundary(root, { contracts: contracts(relativePath), baseline: [] }).violations,
      [],
    );

    const wrongModule = checkBypassWriteBoundary(root, {
      contracts: contracts("packages/storage/src/store/other-database.ts"),
      baseline: [],
    });
    assert.ok(wrongModule.violations.some(({ message }) => /does not match declared source module/u.test(message)));

    const wrongMedium = checkBypassWriteBoundary(root, {
      contracts: contracts(relativePath, "filesystem-store"),
      baseline: [],
    });
    assert.ok(
      wrongMedium.violations.some(({ message }) => /SQLite API .* does not match declared medium/u.test(message)),
    );

    const file = path.join(root, relativePath);
    writeFileSync(
      file,
      "import { DatabaseSync } from 'node:sqlite';\nconst db = /* @gate-identity state-store/demo.sqlite */ new DatabaseSync('state.db');\n/* @gate-identity state-store/demo.sqlite */ db.exec('/* @gate-identity state-store/demo.sqlite */ CREATE TABLE rogue_rows (id TEXT)');\n",
    );
    const undeclaredTable = checkBypassWriteBoundary(root, { contracts: contracts(relativePath), baseline: [] });
    assert.ok(
      undeclaredTable.violations.some(({ message }) => /table rogue_rows does not match declared/u.test(message)),
    );
    assert.ok(undeclaredTable.violations.some(({ message }) => /declared database table is stale/u.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts only a path-bound, reasoned environment I/O declaration", () => {
  const relativePath = "packages/demo/src/installer.ts";
  const marker = "environment-io.demo-installer";
  const root = fixture(
    [
      "import { writeFileSync } from 'node:fs';",
      `/* @gate-identity non-state/${marker} */ writeFileSync('installed.marker', 'ready');`,
    ].join("\n"),
    relativePath,
  );
  const declaration = {
    id: marker,
    path: relativePath,
    category: "environment-io",
    api: "writeFileSync",
    scope: "<module>",
    reason: "Records an installed tool marker for environment setup, not business workflow state.",
  };
  try {
    assert.deepEqual(
      checkBypassWriteBoundary(root, {
        contracts: [],
        baseline: [],
        nonStateIoDeclarations: [declaration],
      }).violations,
      [],
    );

    const wrongCategory = checkBypassWriteBoundary(root, {
      contracts: [],
      baseline: [],
      nonStateIoDeclarations: [{ ...declaration, category: "anything-goes" }],
    });
    assert.ok(wrongCategory.violations.some(({ message }) => /category must be environment-io/u.test(message)));
    assert.ok(wrongCategory.violations.some(({ message }) => /non-state I\/O marker is undeclared/u.test(message)));

    const missingReason = checkBypassWriteBoundary(root, {
      contracts: [],
      baseline: [],
      nonStateIoDeclarations: [{ ...declaration, reason: " " }],
    });
    assert.ok(missingReason.violations.some(({ message }) => /requires a reason/u.test(message)));

    for (const changed of [
      { path: "packages/demo/src/another-installer.ts" },
      { api: "renameSync" },
      { scope: "otherScope" },
    ]) {
      const misplaced = checkBypassWriteBoundary(root, {
        contracts: [],
        baseline: [],
        nonStateIoDeclarations: [{ ...declaration, ...changed }],
      });
      assert.ok(misplaced.violations.some(({ message }) => /non-state I\/O marker is undeclared/u.test(message)));
    }

    writeFileSync(
      path.join(root, relativePath),
      `import { DatabaseSync } from 'node:sqlite';\n/* @gate-identity non-state/${marker} */ new DatabaseSync('state.db');\n`,
    );
    const disguisedDatabase = checkBypassWriteBoundary(root, {
      contracts: [],
      baseline: [],
      nonStateIoDeclarations: [{ ...declaration, api: "DatabaseSync" }],
    });
    assert.ok(disguisedDatabase.violations.some(({ message }) => /non-state I\/O marker is undeclared/u.test(message)));

    writeFileSync(path.join(root, relativePath), "export const noIo = true;\n");
    const stale = checkBypassWriteBoundary(root, {
      contracts: [],
      baseline: [],
      nonStateIoDeclarations: [declaration],
    });
    assert.ok(stale.violations.some(({ message }) => /non-state I\/O declaration is stale/u.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires a cache adapter to match its registered medium exactly", () => {
  const root = fixture(
    ["import { createClient } from 'redis';", "/* @gate-identity state-store/demo.cache */ createClient();"].join("\n"),
  );
  try {
    const contracts = [
      {
        kind: "demo",
        stateStores: [
          {
            id: "demo.cache",
            role: "replica",
            residency: "runtime-local",
            medium: { kind: "shared-cache", adapter: "redis#wrongExport" },
            vocabulary: [],
            source: { kind: "demo", store: "demo.authority" },
            freshness: { cursor: "revision" },
            invalidation: "rebuild-on-start",
            reader: "readDemoCache",
          },
        ],
      },
    ];
    const result = checkBypassWriteBoundary(root, { contracts, baseline: [] });
    assert.ok(result.violations.some(({ message }) => /does not match declared medium\.adapter/u.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freezes the medium of unresolved baseline entries", () => {
  const root = fixture("import { writeFileSync } from 'node:fs';\nwriteFileSync('state.json', '{}');\n");
  try {
    const finding = scanBypassWriteCalls(root)[0];
    const baseline = [{ key: finding.key, kind: finding.kind, api: finding.api, medium: "sqlite", count: 1 }];
    assert.match(
      checkBypassWriteBoundary(root, { contracts: [], baseline }).violations[0].message,
      /changed API or medium/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache driver imports are limited to the registered storage adapter module", () => {
  const body = [
    "/* @gate-identity state-store/demo.cache */",
    "export class DemoCache implements CrossProcessCachePort {}",
    "import { createClient as makeClient } from 'redis';",
    "void makeClient;",
  ].join("\n");
  const adapter = "packages/storage/src/demo-cache.ts";
  assert.deepEqual(auditCacheDriverImports([{ path: adapter, text: body }], [adapter]), []);
  assert.match(
    auditCacheDriverImports([{ path: adapter, text: body }], ["packages/storage/src/other.ts"])[0].message,
    /registered storage CrossProcessCachePort adapter/u,
  );
  assert.equal(auditCacheDriverImports([{ path: "packages/daemon/src/cache.ts", text: body }], [adapter]).length, 1);
  assert.deepEqual(cacheDriverAdapterCandidates([{ path: adapter, text: body }]), [adapter]);
  assert.deepEqual(
    cacheDriverAdapterCandidates([{ path: adapter, text: "import { createClient } from 'redis';" }]),
    [],
  );
});

test("removes resolved debt and rejects a stale baseline entry", () => {
  const root = fixture("import { writeFileSync } from 'node:fs';\nwriteFileSync('state.json', '{}');\n");
  try {
    const finding = scanBypassWriteCalls(root)[0];
    const baseline = [{ key: finding.key, kind: finding.kind, api: finding.api, medium: finding.medium, count: 1 }];
    assert.deepEqual(checkBypassWriteBoundary(root, { contracts: [], baseline }).violations, []);
    writeFileSync(path.join(root, "packages/demo/src/state-writer.ts"), "export const noState = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    assert.match(
      checkBypassWriteBoundary(root, { contracts: [], baseline }).violations[0].message,
      /baseline entry is stale/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
