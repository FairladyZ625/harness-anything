// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWriterIsolate, writerEntries } from "./check-writer-isolate.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "writer-isolate-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  for (const { entry } of writerEntries) write(entry, "export {};\n");
  return { root, write };
}

// dec_04A9211B073F29F0FC1E1CA573 CH2: each capability lock has an adversarial control.
test("accepts pure writers and rejects direct and transitive process/network imports", (t) => {
  const { root, write } = fixture(t),
    entry = writerEntries[0].entry;
  assert.equal(checkWriterIsolate(root).ok, true);
  write(entry, 'import "./leak.ts";\n');
  for (const capability of ["child_process", "http", "https", "net", "tls", "http2", "dgram", "dns"]) {
    write("packages/daemon/src/writer-cell/leak.ts", `import "node:${capability}";\n`);
    assert.ok(
      checkWriterIsolate(root).violations.some((v) => v.includes(`node:${capability}`)),
      capability,
    );
  }
});

test("rejects host query modules and callback bridges", (t) => {
  const { root, write } = fixture(t),
    entry = writerEntries[0].entry;
  write("packages/application/src/queries/read.ts", "export {};\n");
  write(entry, 'import "../../../application/src/queries/read.ts";\n');
  assert.ok(checkWriterIsolate(root).violations.some((v) => v.includes("forbidden module")));
  for (const name of ["syncCapability", "asyncCapability"]) {
    write(entry, `${name}("runtimeLaunch", {});\n`);
    assert.ok(
      checkWriterIsolate(root).violations.some((v) => v.includes("capability bridge")),
      name,
    );
  }
});

test("rejects test libraries and external drivers in the SQLite closure", (t) => {
  const { root, write } = fixture(t),
    entry = writerEntries[0].entry;
  for (const name of ["fast-check", "pure-rand", "undici", "ws", "node-pty", "pg", "@electric-sql/pglite"]) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, exports: "./index.js", type: "module" }));
    write(`node_modules/${name}/index.js`, "export {};\n");
    write(entry, `import "${name}";\n`);
    assert.equal(checkWriterIsolate(root).ok, false, name);
  }
});

test("permits PG transport only through storage/postgres/transaction and rejects a bypass path", (t) => {
  const { root, write } = fixture(t),
    entry = writerEntries[1].entry;
  write("node_modules/pg/package.json", JSON.stringify({ name: "pg", exports: "./index.js", type: "module" }));
  write("node_modules/pg/index.js", 'import "node:net"; import "node:tls";\n');
  write("packages/storage/src/postgres/transaction.ts", 'import "pg";\n');
  write(entry, 'import "../../../storage/src/postgres/transaction.ts";\n');
  assert.equal(checkWriterIsolate(root).ok, true);
  write(entry, 'import "../../../storage/src/postgres/transaction.ts"; import "pg";\n');
  assert.ok(checkWriterIsolate(root).violations.some((v) => v.includes("network capability")));
  write(entry, 'import "../../../storage/src/postgres/transaction.ts";\n');
  for (const capability of ["child_process", "http", "https", "http2", "dgram"]) {
    write("node_modules/pg/index.js", `import "node:${capability}";\n`);
    assert.ok(
      checkWriterIsolate(root).violations.some((v) => v.includes(`node:${capability}`)),
      capability,
    );
  }
});

test("rejects runtime effect and kernel root barrels while allowing type-only imports", (t) => {
  const { root, write } = fixture(t),
    entry = writerEntries[0].entry;
  for (const name of ["effect", "@harness-anything/kernel"]) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, exports: "./index.js", type: "module" }));
    write(`node_modules/${name}/index.js`, "export const value = 1;\n");
    write(entry, `import { value } from "${name}";\n`);
    assert.ok(
      checkWriterIsolate(root).violations.some((v) => v.includes(`runtime root barrel ${name}`)),
      name,
    );
    write(entry, `import type { Value } from "${name}";\n`);
    assert.equal(checkWriterIsolate(root).ok, true);
  }
});

test("fails closed above sixty daemon modules", (t) => {
  const { root, write } = fixture(t),
    entry = writerEntries[0].entry;
  write(entry, Array.from({ length: 60 }, (_, i) => `import "./module-${i}.ts";`).join("\n"));
  for (let i = 0; i < 60; i++) write(`packages/daemon/src/writer-cell/module-${i}.ts`, "export {};\n");
  assert.ok(checkWriterIsolate(root).violations.some((v) => v.includes("daemon closure 61 exceeds 60")));
});

test("registers cloud writer shard, PG cloud repository, and PGlite worker and rejects queries or root barrel imports", (t) => {
  const entries = new Set(writerEntries.map((item) => item.entry));
  assert.ok(entries.has("packages/daemon/src/writer-cell/cloud-writer-shard.ts"));
  assert.ok(entries.has("packages/daemon/src/writer-cell/cloud-writer-pg-repository.ts"));
  assert.ok(entries.has("packages/daemon/src/writer-cell/repo-writer-worker-pglite.ts"));

  const { root, write } = fixture(t),
    cloudEntry = "packages/daemon/src/writer-cell/cloud-writer-shard.ts";
  assert.equal(checkWriterIsolate(root).ok, true);

  write(
    "packages/application/src/queries/task-completion-read.ts",
    "export const readCompletionContext = () => ({});\n",
  );
  write(cloudEntry, 'import "../../../application/src/queries/task-completion-read.ts";\n');
  assert.ok(
    checkWriterIsolate(root).violations.some(
      (v) =>
        v.includes(cloudEntry) &&
        v.includes("forbidden module packages/application/src/queries/task-completion-read.ts"),
    ),
  );

  write(
    "node_modules/@harness-anything/kernel/package.json",
    JSON.stringify({ name: "@harness-anything/kernel", exports: "./index.js", type: "module" }),
  );
  write("node_modules/@harness-anything/kernel/index.js", "export const sha256Text = (v) => v;\n");
  write(cloudEntry, 'import { sha256Text } from "@harness-anything/kernel"; void sha256Text;\n');
  assert.ok(
    checkWriterIsolate(root).violations.some(
      (v) => v.includes(cloudEntry) && v.includes("runtime root barrel @harness-anything/kernel"),
    ),
  );
});
