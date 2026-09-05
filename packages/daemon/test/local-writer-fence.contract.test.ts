// harness-test-tier: contract
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

test("every production local binding is covered by a request or cell-default writer fence", () => {
  const uses = localSourceUses(),
    counts = new Map<string, number>();
  for (const use of uses) counts.set(use.file, (counts.get(use.file) ?? 0) + 1);

  assert.deepEqual(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
    [
      ["daemon-host-binding.ts", 2],
      ["host-action-authorization.ts", 1],
      ["repo-cell-authorization.ts", 1],
      ["repo-cell-open.ts", 1],
      ["repo-cell.ts", 1],
    ],
    `unclassified production source:local use:\n${uses.map((use) => `${use.file}:${use.line}`).join("\n")}`,
  );

  const cell = source("repo-cell.ts");
  assert.match(cell, /walMaterializationFence: \(\) => context\.activeWriterEpochFenceDescriptor/u);
  assert.match(cell, /beforeAppend: \(\) => context\.activeWriterEpochGuard\?\.\(\)/u);
  assert.match(cell, /context\.activeWriterEpochFence\(operation\)/u);
  assert.match(cell, /const fence = context\.activeWriterEpochFenceDescriptor/u);

  const open = source("repo-cell-open.ts");
  assert.match(open, /return activeWriterEpochGuard \?\? defaultWriterEpochGuard/u);
  assert.match(open, /return activeWriterEpochFence \?\? defaultWriterEpochFence/u);
  assert.match(open, /return activeWriterEpochFenceDescriptor \?\? cellWriterEpochFence \?\? null/u);
  assert.match(open, /defaultWriterEpochFence\?: NonNullable<RepoCellBinding\["writerEpochFence"\]>/u);

  assert.match(
    source("daemon-host-open.ts"),
    /return writerRepoId \? daemonWriterBinding\(writerRepoId, base\) : base/u,
  );
  assert.match(
    source("daemon-host-registry.ts"),
    /defaultWriterEpochFence: context\.writerEpochFence\(repo\.repoId\)/u,
  );
  assert.match(
    source("daemon-host-repository-api.ts"),
    /defaultWriterEpochFence: context\.writerEpochFence\(prepared\.repoId\)/u,
  );
  assert.match(source("writer-supervisor.ts"), /defaultWriterEpochFence: input\.defaultWriterEpochFence/u);

  for (const authorizationFile of ["host-action-authorization.ts", "repo-cell-authorization.ts"])
    assert.match(
      source(authorizationFile),
      /defaultBinding:\s*\{\s*principalPersonId:[\s\S]*?source: "local" as const/u,
      `${authorizationFile} source:local must remain authorization context, not a write binding`,
    );
});

function localSourceUses(): readonly { readonly file: string; readonly line: number }[] {
  return sourceFiles(sourceRoot).flatMap((absolute) => {
    const body = readFileSync(absolute, "utf8"),
      matches = body.matchAll(/\bsource\s*:\s*"local"(?:\s+as\s+const)?/gu);
    return [...matches].map((match) => ({
      file: path.relative(sourceRoot, absolute).split(path.sep).join("/"),
      line: body.slice(0, match.index).split("\n").length,
    }));
  });
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function source(relative: string): string {
  return readFileSync(path.join(sourceRoot, relative), "utf8");
}
