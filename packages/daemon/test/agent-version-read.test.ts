// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileAgentRetired,
  createEntityStore,
  makeTaskEventStore,
  makeTaskProjection,
  sha256Text,
} from "@harness-anything/kernel";
import { prepareAgentEntityInstall } from "../src/agent-entities.ts";
import {
  diffAgentDeclarations,
  diffInstructionLines,
  readAgentDiff,
  readAgentHistory,
  readAgentVersion,
  summarizeAgentDeclaration,
} from "../src/agent-version-read.ts";
import { validateAgentHistory, validateAgentVersion } from "../src/protocol/agent-entity-gui-contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { appendLegacyAgentDeclaration, initRepo } from "./agent-entities.fixtures.ts";

/**
 * The ledger is already the version history. These tests pin the three things the read surface is
 * responsible for: it reports every upsert as a version with the body digest the content object
 * really holds, it reports the declaration revision (never the retire-advanced projection row
 * revision), and a diff of two revisions states the real field changes.
 */

const declaration = (instructions: string, extra: Record<string, unknown> = {}) => ({
    schema: "agent-declaration/v1",
    id: "versioned",
    name: "Versioned",
    instructions,
    runtimes: [{ type: "codex" }],
    ...extra,
  }),
  actor = { principal: { personId: "person-version" }, executor: null };

interface Fixture {
  readonly rootDir: string;
  readonly revisions: readonly number[];
  readonly projection: ReturnType<typeof makeTaskProjection>;
  readonly store: ReturnType<typeof makeTaskEventStore>;
}

/** Writes declarations through the real install preparation, so the stored bodies are what the
 *  daemon would publish: JSON.stringify(declaration, null, 2) + "\n". */
function fixture(bodies: readonly Record<string, unknown>[]): Fixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-version-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId: "agent-entities", rootDir }),
    revisions: number[] = [];
  for (const [index, body] of bodies.entries()) {
    const prepared = prepareAgentEntityInstall({
        rootDir,
        action: { kind: "agent-install", declaration: body },
      }),
      revision = (store.readHead()?.revision ?? 0) + 1;
    store.append(
      createEntityStore(store).upsert({
        entityKind: "agent",
        entity: prepared.declaration,
        eventId: `event-${index}`,
        opId: `op-${index}`,
        workspaceRevision: revision,
        actor,
        source: "local",
        occurredAt: `2026-10-26T00:00:0${index}.000Z`,
      }),
    );
    revisions.push(revision);
  }
  const projection = makeTaskProjection({ rootDir, eventStore: store });
  projection.catchUp();
  return { rootDir, revisions, projection, store };
}

function ports(f: Fixture) {
  return { projection: f.projection, store: f.store };
}

test("history lists every version newest-first with the body digest the content object holds", () => {
  const f = fixture([declaration("first body"), declaration("second body"), declaration("third body")]);
  try {
    const history = readAgentHistory(ports(f), { agentId: "versioned" });
    assert.equal(history.schema, "agent-history/v1");
    assert.deepEqual(
      history.versions.map((row) => row.revision),
      [...f.revisions].reverse(),
      "newest first",
    );
    assert.equal(history.revision, f.revisions.at(-1), "the live declaration revision");
    assert.equal(history.hasMore, false);
    assert.equal(history.nextCursor, null);
    assert.deepEqual(
      history.versions.map((row) => row.current),
      [true, false, false],
      "exactly one current version, and it is first",
    );
    // The claim digest is not decoration: it must be the digest of the bytes the read returns.
    for (const row of history.versions) {
      const bytes = f.store.readContentBlob(row.sha256);
      assert.ok(bytes, `content object ${row.sha256} must be retained`);
      assert.equal(sha256Text(new TextDecoder().decode(bytes)), row.sha256);
      assert.equal(row.size, bytes.byteLength);
    }
    assert.deepEqual(
      history.versions.map((row) => row.summary),
      [
        "instructions 10 B · 0 skills · 1 runtime",
        "instructions 11 B · 0 skills · 1 runtime",
        "instructions 10 B · 0 skills · 1 runtime",
      ],
    );
    assert.deepEqual(validateAgentHistory(history), []);
    assert.doesNotThrow(() => parseDaemonGuiReadResult("repo.agent.history.read", history));
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("history paging crosses the last page and then reports no more rows", () => {
  const f = fixture([declaration("v1"), declaration("v2"), declaration("v3")]);
  try {
    const seen: number[] = [];
    let cursor: string | undefined,
      pages = 0;
    // Terminate on the reader's own signal (`hasMore`), never on a non-null cursor.
    for (;;) {
      const page = readAgentHistory(ports(f), {
        agentId: "versioned",
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages += 1;
      seen.push(...page.versions.map((row) => row.revision));
      if (!page.hasMore) {
        assert.equal(page.nextCursor, null);
        break;
      }
      assert.ok(page.nextCursor, "a page with hasMore must name its next boundary");
      cursor = page.nextCursor;
      assert.ok(pages < 10, "paging must terminate");
    }
    assert.deepEqual(seen, [...f.revisions].reverse(), "every version once, newest first");
    // The page past the end is the empty page, not a repeat of the last one.
    const exhausted = readAgentHistory(ports(f), {
      agentId: "versioned",
      limit: 2,
      cursor: String(f.revisions[0]),
    });
    assert.deepEqual(exhausted.versions, []);
    assert.equal(exhausted.hasMore, false);
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("--no-summary reads no body: history still answers from the claim alone", () => {
  const f = fixture([declaration("v1"), declaration("v2")]);
  try {
    const history = readAgentHistory(ports(f), { agentId: "versioned", summaries: false });
    assert.deepEqual(
      history.versions.map((row) => row.summary),
      [null, null],
    );
    assert.deepEqual(validateAgentHistory(history), []);
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("a missing agent is agent_not_found, not an empty history", () => {
  const f = fixture([declaration("v1")]);
  try {
    assert.throws(
      () => readAgentHistory(ports(f), { agentId: "absent" }),
      (error: Error & { readonly code?: string }) => error.code === "agent_not_found",
    );
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("a stored declaration this cut cannot interpret is unavailable, not missing", () => {
  // A migration-window declaration (pre-runtimes shape) keeps its row as `unknown` freshness rather
  // than failing the rebuild. The row exists, so "not an installed agent" would name the wrong
  // problem and send the caller to install a different agent; the honest answer is that this
  // agent's versions cannot be read until it is reinstalled.
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-version-degraded-"));
  try {
    appendLegacyAgentDeclaration(rootDir);
    const store = makeTaskEventStore({ repoId: "agent-entities", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.catchUp();
    assert.equal(projection.getEntity("agent", "legacy-worker")?.freshness, "unknown", "fixture sanity");
    for (const read of [
      () => readAgentHistory({ projection, store }, { agentId: "legacy-worker" }),
      () => readAgentVersion({ projection, store }, { agentId: "legacy-worker", revision: 1 }),
    ])
      assert.throws(read, (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "agent_version_unavailable");
        assert.match(error.message, /cannot interpret/u);
        assert.doesNotMatch(error.message, /not an installed agent/u);
        return true;
      });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("retiring an agent does not add a version and does not move the revision", () => {
  const f = fixture([declaration("v1"), declaration("v2")]);
  try {
    const before = readAgentHistory(ports(f), { agentId: "versioned" }),
      live = before.revision;
    // Retire through the kernel's own compiler: agent_retired advances the projection row's
    // workspaceRevision but is not a declaration version.
    const revision = (f.store.readHead()?.revision ?? 0) + 1;
    f.store.append(
      compileAgentRetired({
        entityId: "versioned",
        priorVersion: live,
        retiredAt: "2026-10-26T00:00:09.000Z",
        reason: "superseded",
        eventId: "event-retire",
        opId: "op-retire",
        workspaceRevision: revision,
        actor,
        source: "local",
        occurredAt: "2026-10-26T00:00:09.000Z",
      }),
    );
    const after = makeTaskProjection({ rootDir: f.rootDir, eventStore: f.store });
    after.catchUp();
    const projectionRow = after.getEntity("agent", "versioned");
    assert.ok(projectionRow, "the retired row stays readable");
    const history = readAgentHistory(ports({ ...f, projection: after }), { agentId: "versioned" });
    assert.equal(history.revision, live, "the declaration revision is unchanged by retirement");
    assert.deepEqual(
      history.versions.map((row) => row.revision),
      [...f.revisions].reverse(),
      "retirement is not a version",
    );
    assert.equal(
      history.versions.some((row) => row.revision === revision),
      false,
      "the agent_retired event revision must not appear as a version",
    );
    assert.ok(
      projectionRow.workspaceRevision > live,
      "fixture sanity: the projection row revision did advance, so the read would fail if it used it",
    );
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("one version read returns the retained body and its difference to the live declaration", () => {
  const f = fixture([declaration("v1 body"), declaration("v2 body"), declaration("v3 body")]);
  try {
    const read = readAgentVersion(ports(f), { agentId: "versioned", revision: f.revisions[0]! });
    assert.equal(read.schema, "agent-version/v1");
    assert.equal(read.version.revision, f.revisions[0]);
    assert.equal(read.version.current, false);
    assert.equal(read.current.revision, f.revisions.at(-1));
    assert.equal(read.declaration.instructions, "v1 body");
    assert.deepEqual(validateAgentVersion(read), []);
    assert.doesNotThrow(() => parseDaemonGuiReadResult("repo.agent.version.read", read));
    const instructions = read.fields.find((field) => field.field === "instructions");
    assert.ok(instructions && "lines" in instructions);
    assert.deepEqual(
      instructions.lines.map((line) => [line.kind, line.text]),
      [
        ["remove", "v1 body"],
        ["add", "v3 body"],
      ],
    );

    const current = readAgentVersion(ports(f), { agentId: "versioned", revision: f.revisions.at(-1)! });
    assert.equal(current.version.current, true);
    assert.deepEqual(current.fields, [], "the live version differs from itself in no field");
    assert.equal(current.truncated, false);
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("an out-of-range revision is agent_version_not_found, not a neighbouring version", () => {
  const f = fixture([declaration("v1"), declaration("v2")]);
  try {
    for (const revision of [99, f.revisions[1]! + 5]) {
      assert.throws(
        () => readAgentVersion(ports(f), { agentId: "versioned", revision }),
        (error: Error & { readonly code?: string }) => error.code === "agent_version_not_found",
        `revision ${revision}`,
      );
    }
    // A retried op id does not create a revision, so asking for a gap above the live revision must
    // not silently answer with the newest version.
    assert.throws(
      () => readAgentDiff(ports(f), { agentId: "versioned", from: f.revisions[0]!, to: 42 }),
      (error: Error & { readonly code?: string }) => error.code === "agent_version_not_found",
    );
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("diff states instructions as lines and skills/runtimes as set changes", () => {
  const f = fixture([
    declaration("line one\nline two", { skills: [{ id: "review", path: "skills/review" }] }),
    declaration("line one\nline two changed\nline three", {
      skills: [
        { id: "review", path: "skills/review" },
        { id: "gui", path: "skills/gui" },
      ],
      runtimes: [{ type: "codex" }, { type: "claude" }],
    }),
  ]);
  try {
    const diff = readAgentDiff(ports(f), { agentId: "versioned", from: f.revisions[0]!, to: f.revisions[1]! });
    assert.equal(diff.schema, "agent-diff/v1");
    assert.deepEqual(diff.from, {
      revision: f.revisions[0],
      sha256: readAgentVersion(ports(f), { agentId: "versioned", revision: f.revisions[0]! }).version.sha256,
    });
    const byField = new Map(diff.fields.map((field) => [field.field, field]));
    const instructions = byField.get("instructions");
    assert.ok(instructions && "lines" in instructions);
    assert.deepEqual(
      instructions.lines.map((line) => [line.kind, line.text]),
      [
        ["context", "line one"],
        ["remove", "line two"],
        ["add", "line two changed"],
        ["add", "line three"],
      ],
    );
    const skills = byField.get("skills");
    assert.ok(skills && "added" in skills);
    assert.deepEqual(skills.added, [{ id: "gui", path: "skills/gui" }]);
    assert.deepEqual(skills.removed, []);
    const runtimes = byField.get("runtimes");
    assert.ok(runtimes && "added" in runtimes);
    assert.deepEqual(runtimes.added, [{ type: "claude" }]);
    assert.deepEqual(runtimes.removed, []);
    // Same revision on both sides is an empty difference, not a truncation.
    const empty = readAgentDiff(ports(f), { agentId: "versioned", from: f.revisions[1]!, to: f.revisions[1]! });
    assert.deepEqual(empty.fields, []);
    assert.equal(empty.truncated, false);
  } finally {
    rmSync(f.rootDir, { recursive: true, force: true });
  }
});

test("a key-order change is not a field difference", () => {
  const before = {
      schema: "agent-declaration/v1",
      id: "a",
      name: "A",
      instructions: "body",
      runtimes: [{ type: "codex" }],
    },
    reordered = {
      instructions: "body",
      id: "a",
      runtimes: [{ type: "codex" }],
      name: "A",
      schema: "agent-declaration/v1",
    };
  assert.deepEqual(diffAgentDeclarations(before, reordered), { fields: [], truncated: false });
});

test("the line diff bounds its output and falls back to a block replace for large inputs", () => {
  const small = diffInstructionLines("a\nb", "a\nc");
  assert.equal(small.truncated, false);
  assert.deepEqual(
    small.lines.map((line) => [line.kind, line.text]),
    [
      ["context", "a"],
      ["remove", "b"],
      ["add", "c"],
    ],
  );
  // Over the LCS cell budget the same two texts still diff completely, only coarsely.
  const big = Array.from({ length: 900 }, (_, index) => `line ${index}`),
    bigChanged = Array.from({ length: 900 }, (_, index) => `line ${index} changed`),
    coarse = diffInstructionLines(big.join("\n"), bigChanged.join("\n"));
  assert.equal(coarse.lines.length, 1_800);
  assert.equal(coarse.lines.filter((line) => line.kind === "remove").length, 900, "every old line is still reported");
  assert.equal(coarse.lines.filter((line) => line.kind === "add").length, 900, "every new line is still reported");
});

test("the version summary states real body measurements", () => {
  assert.equal(
    summarizeAgentDeclaration({
      instructions: "12345",
      skills: [
        { id: "a", path: "p" },
        { id: "b", path: "q" },
      ],
      runtimes: [{ type: "codex" }],
    }),
    "instructions 5 B · 2 skills · 1 runtime",
  );
  // Multi-byte instructions are counted in bytes, not code points.
  assert.equal(
    summarizeAgentDeclaration({ instructions: "版本", runtimes: [] }),
    "instructions 6 B · 0 skills · 0 runtimes",
  );
});
