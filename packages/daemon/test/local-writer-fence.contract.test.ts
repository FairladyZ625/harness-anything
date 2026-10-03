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

  // dec_D60FAA451F24160E970323B6F3 CH1/CH4: retire roster authority, retain writer leases.
  // Owner-confirmed inventory; the fence assertions below independently protect writes.
  assert.deepEqual(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
    [
      ["daemon-host-binding.ts", 2],
      ["daemon-host-open.ts", 1],
      ["repo-cell-bootstrap-ledger.ts", 1],
    ],
    `unclassified production source:local use:\n${uses.map((use) => `${use.file}:${use.line}`).join("\n")}`,
  );

  const cell = source("repo-cell.ts");
  assert.match(cell, /writerFence: \(\) =>/u);
  assert.match(cell, /if \(!fence\) throw new Error/u);
  assert.match(cell, /context\.activeWriterEpochFence\(operation\)/u);
  assert.match(cell, /const fence = context\.activeWriterEpochFenceDescriptor/u);

  const open = source("repo-cell-open.ts");
  assert.match(open, /return activeWriterEpochFence \?\? defaultWriterEpochFence/u);
  assert.match(open, /return activeWriterEpochFenceDescriptor \?\? cellWriterEpochFence \?\? null/u);
  assert.match(open, /defaultWriterEpochFence\?: NonNullable<RepoCellBinding\["writerEpochFence"\]>/u);

  assert.match(
    source("daemon-host-open.ts"),
    /return writerRepoId \? daemonWriterBinding\(writerRepoId, base\) : base/u,
  );
  const host = source("daemon-host-open.ts");
  assert.match(host, /return withDaemonWriterEpochFence\(base, writerEpochFence\(repoId\)\)/u);
  // Schedule reads use system authority; occurrence writes use the canonical creator
  // and Keycloak authorization, with a request fence for that repository.
  assert.match(host, /if \(action\.kind === "schedule-list"\) return system/u);
  assert.match(host, /cell\.run\(\{ kind: "schedule-show", scheduleId: action\.scheduleId \}, system\)/u);
  assert.match(host, /if \(!schedule \|\| validateScheduleV1\(schedule\)\.length\)\s*throw hostCodedError/u);
  assert.match(
    host,
    /return daemonWriterBinding\(repoId, \{\s*actor: \{ principal: schedule\.createdBy\.principal, executor: null \},\s*source: "local",\s*keycloakAuthorization: \{ center: await keycloakCenter\(\) \},\s*\}\)/u,
  );
  assert.match(
    source("daemon-host-binding.ts"),
    /writerEpoch: descriptor\.epoch,[\s\S]*?withWriterEpochFence: <T>\(operation: \(\) => T\) => withWriterEpochFenceDescriptor\(descriptor, operation\),\s*writerEpochFence: descriptor/u,
  );
  assert.match(
    source("daemon-host-registry.ts"),
    /defaultWriterEpochFence: context\.writerEpochFence\(repo\.repoId\)/u,
  );
  assert.match(
    source("daemon-host-repository-api.ts"),
    /defaultWriterEpochFence: context\.writerEpochFence\(prepared\.repoId, prepared\.rootDir\)/u,
  );
  assert.match(source("writer-supervisor.ts"), /defaultWriterEpochFence: input\.defaultWriterEpochFence/u);

  assert.doesNotMatch(
    source("repo-cell-authorization.ts"),
    /defaultBinding:/u,
    "repository writes require explicit Keycloak or assignment authorization",
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
