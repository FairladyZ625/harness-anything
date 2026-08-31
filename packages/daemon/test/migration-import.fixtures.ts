import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  REPLAY_TASK_GRAPH,
  deriveRelationId,
  readLegacyMigrationSource,
  readMarkdownSource,
  readScalar,
  sha256Text,
  taskEntryToRow,
} from "../../kernel/src/index.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

export const actor = {
  principal: { personId: "migration-owner" },
  executor: { kind: "agent", id: "codex" },
} as const;

export function legacyFixture(root: string): void {
  const taskRoot = path.join(root, "harness/tasks/task_legacy-old"),
    badRoot = path.join(root, "harness/tasks/task_bad"),
    decisionRoot = path.join(root, "harness/decisions/decision-dec_LEGACY");
  mkdirSync(taskRoot, { recursive: true });
  mkdirSync(badRoot, { recursive: true });
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    "---\nschema: task-package/v2\ntask_id: task_legacy\ntitle: Legacy done task\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Legacy done task\n",
  );
  writeFileSync(path.join(badRoot, "INDEX.md"), "# missing frontmatter\n");
  writeFileSync(
    path.join(taskRoot, "facts.md"),
    "# Facts\n\n- {fact_id: F-ABCDEFGH, statement: Observed migration, source: legacy-test, observedAt: 2026-01-02T00:00:00.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-01-02T00:00:00.000Z}]}\n- {fact_id: F-MGRATEDX, statement: Archived execution evidence, source: legacy-test, observedAt: 2026-01-02T12:00:00.000Z, confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-01-02T12:00:00.000Z}], migration: {schema: fact-migration/v1, state: migrated, plan_id: fxm_test, execution_ref: execution/task_legacy/exe_test, evidence_id: fact-migration:fxm_test:F-MGRATEDX, migrated_at: 2026-01-04T00:00:00.000Z}}\n",
  );
  const relation = {
    relation_id: deriveRelationId({
      source: "decision/dec_LEGACY/C1",
      target: "fact/task_legacy/F-ABCDEFGH",
      type: "evidenced-by",
      direction: "directed",
    }),
    source: "decision/dec_LEGACY/C1",
    target: "fact/task_legacy/F-ABCDEFGH",
    type: "evidenced-by",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "Legacy observation supports the claim.",
    state: "active",
  };
  const migratedFactRelation = {
    relation_id: deriveRelationId({
      source: "decision/dec_LEGACY/C1",
      target: "fact/task_legacy/F-MGRATEDX",
      type: "evidenced-by",
      direction: "directed",
    }),
    source: "decision/dec_LEGACY/C1",
    target: "fact/task_legacy/F-MGRATEDX",
    type: "evidenced-by",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "The historical relation keeps its migrated fact endpoint resolvable.",
    state: "retired",
  };
  writeFileSync(
    path.join(decisionRoot, "decision.md"),
    `---\nschema: decision-package/v1\ndecision_id: dec_LEGACY\nworkspaceRevision: 7\ntitle: "Legacy decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["kernel"],"productLines":["harness"]}\nproposedAt: "2026-01-01T12:00:00.000Z"\ndecidedAt: "2026-01-03T00:00:00.000Z"\nquestion: "Should the history migrate?"\nchosen: [{"id":"CH1","text":"Migrate it"}]\nrejected: [{"id":"RJ1","text":"Drop it","whyNot":"History is required"}]\nclaims: [{"id":"C1","text":"History remains auditable","loadBearing":true,"fulfillment":"evidenced"}]\nrelations: ${JSON.stringify([relation, migratedFactRelation])}\n---\n\n# Legacy decision\n\nPreserved prose.\n`,
  );
}
export function coverageGapFixture(root: string): void {
  coverageCompleteFixture(root);
  const taskRoot = path.join(root, "harness/tasks/task_coverage-old"),
    mysteryRoot = path.join(root, "harness/mystery"),
    objectsRoot = path.join(root, "harness/objects/sha256/aa"),
    presetRoot = path.join(root, "harness/presets/example");
  mkdirSync(mysteryRoot, { recursive: true });
  mkdirSync(objectsRoot, { recursive: true });
  mkdirSync(presetRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "task_plan.md"), realizedTaskPlan("Legacy done task"));
  writeFileSync(path.join(mysteryRoot, "orphan.md"), "# This path has no migration rule\n");
  writeFileSync(path.join(objectsRoot, "blob"), "rebuildable CAS\n");
  writeFileSync(path.join(presetRoot, "preset.json"), '{"schema":"harness-preset/v1"}\n');
}
export function unfamiliarDocumentFixture(root: string): void {
  const notes = path.join(root, "harness/field-notes/2024");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(notes, "xyz.md"),
    "# Field observation\n\nUnknown directories are ordinary authored content.\n",
  );
}
export function referencedDocumentFixture(root: string, referencedBody: string): void {
  const hash = sha256Text(referencedBody),
    notes = path.join(root, "harness/field-notes"),
    objects = path.join(root, `harness/objects/sha256/${hash.slice(0, 2)}`);
  mkdirSync(notes, { recursive: true });
  mkdirSync(objects, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(notes, "reference.json"),
    `${JSON.stringify({ schema: "unfamiliar-record/v1", nested: { attachment: { store: "authored-cas/v1", ref: `harness/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2)}`, sha256: hash, size: Buffer.byteLength(referencedBody), mediaType: "text/markdown; charset=utf-8" } } }, null, 2)}\n`,
  );
  writeFileSync(path.join(objects, hash.slice(2)), referencedBody);
}
export function binaryAttachmentFixture(root: string): void {
  coverageCompleteFixture(root);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
    notes = path.join(root, "harness/field-notes"),
    artifacts = path.join(root, "harness/tasks/task_coverage-old/artifacts");
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, "screenshot.png"), bytes);
  writeFileSync(path.join(artifacts, "screenshot.png"), bytes);
}
export function symbolicLinkFixture(root: string, linkTarget: string): void {
  const notes = path.join(root, "harness/field-notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  symlinkSync(linkTarget, path.join(notes, "latest.md"));
}
export function coverageCompleteFixture(root: string): void {
  const taskRoot = path.join(root, "harness/tasks/task_coverage-old"),
    artifactRoot = path.join(taskRoot, "artifacts"),
    executionRoot = path.join(taskRoot, "executions"),
    nestedExecutionRoot = path.join(artifactRoot, "probe/executions");
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(executionRoot, { recursive: true });
  mkdirSync(nestedExecutionRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    "---\nschema: task-package/v2\ntask_id: task_coverage\ntitle: Coverage fixture\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nlegacyOpaque: keep-this-source-field\n---\n\n# Coverage fixture\n\n## Lifecycle Note\n\nArchived as superseded; archivedBy=person_historical\n",
  );
  writeFileSync(path.join(taskRoot, "task_plan.md"), realizedTaskPlan("Coverage fixture"));
  writeFileSync(path.join(artifactRoot, "evidence.html"), "<p>historical evidence</p>\n");
  writeFileSync(path.join(artifactRoot, "INDEX.md"), "# Artifact index\n");
  writeFileSync(path.join(nestedExecutionRoot, "exe_nested.md"), "# Nested fixture\n");
  writeFileSync(
    path.join(executionRoot, "exe_history.md"),
    `${JSON.stringify({ schema: "execution/v2", execution_id: "exe_history", task_ref: "task/task_coverage", state: "accepted", primary_actor: { principal: { personId: "person_historical" }, executor: { kind: "agent", id: "legacy-agent" }, responsibleHuman: "person:historical" }, claimed_at: "2026-01-02T00:00:00.000Z", submitted_at: "2026-01-03T00:00:00.000Z", closed_at: "2026-01-04T00:00:00.000Z", session_bindings: [], outputs: [{ evidence_id: "legacy-output", execution_ref: "execution/task_coverage/exe_history", locator: { substrate: "file", path: "artifacts/evidence.html" } }], submission: { completion_claim: "Historical work completed.", deliverables: ["evidence"], evidence_refs: ["legacy-output"], verification_notes: ["legacy verification"], known_gaps: [], residual_risks: [] } }, null, 2)}\n`,
  );
}
export function decisionContentFixture(root: string): void {
  const decisionRoot = path.join(root, "harness/decisions/decision-dec_CONTENT");
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(decisionRoot, "decision.md"),
    `---\nschema: decision-package/v1\ndecision_id: dec_CONTENT\nworkspaceRevision: 3\ntitle: "Content decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\napplies_to: {"modules":[],"productLines":[]}\nproposedAt: "2026-01-01T12:00:00.000Z"\ndecidedAt: "2026-01-03T00:00:00.000Z"\ncontentPins:\n  - { action: "accept", digest: "sha256:aaaaaaaa" }\nprovenance:\n  - { runtime: "codex", sessionId: "legacy-session", boundAt: "2026-01-01T12:00:00.000Z" }\nquestion: "Will every source field remain readable?"\nchosen: [{"id":"CH1","text":"Preserve it"}]\nrejected: [{"id":"RJ1","text":"Drop it","whyNot":"Information matters"}]\nclaims: [{"id":"C1","text":"The source survives","loadBearing":false}]\nrelations:\n---\n\n# Content decision\n\nPreserve this rationale verbatim.\n`,
  );
}
// `ha init` always writes both harness.yaml and people.yaml, so a destination fixture without a roster
// cannot reproduce what a real migration lands on.
export const bootstrapPerson = {
  personId: "person_zeyu",
  displayName: "Zeyu Li",
  roles: ["owner"],
  credentials: [
    {
      kind: "unix-socket-owner-boundary",
      issuer: "host:MacBook-Pro.local",
      subject: "501",
    },
  ],
} as const;
export function bootstrapRoster(people: readonly Readonly<Record<string, unknown>>[] = [bootstrapPerson]): string {
  return `${JSON.stringify({ schema: "harness-people/v1", people, roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`;
}
export const legacyRoster = `schema: harness-people/v1
people:
  - personId: person_zeyu
    displayName: "Zeyu Li"
    primaryEmail: "lizeyu990625@gmail.com"
    roles: [owner]
    credentials:
      - kind: unix-socket-owner-boundary
        issuer: host:MacBook-Pro.local
        subject: 501
  - personId: person_dingwen
    displayName: "Dingwen"
    roles: [owner]
    credentials:
      - kind: email-address
        issuer: example.invalid
        subject: dingwen@example.invalid
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
`;

export function initRepo(root: string, roster: string = bootstrapRoster()): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Migration Test");
  git(root, "config", "user.email", "migration@example.invalid");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(path.join(root, "harness/people.yaml"), roster);
  git(root, "add", ".");
  git(root, "commit", "-qm", "initialized");
}
export function multiSourceFixture(root: string, label: string, personId: string): void {
  const taskRoot = path.join(root, `harness/tasks/task_shared-${label}`),
    decisionRoot = path.join(root, "harness/decisions/decision-dec_SHARED");
  mkdirSync(taskRoot, { recursive: true });
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    bootstrapRoster([
      bootstrapPerson,
      {
        personId,
        displayName: label,
        roles: ["owner"],
        credentials: [
          {
            kind: "email-address",
            issuer: "example.invalid",
            subject: `${label}@example.invalid`,
          },
        ],
      },
    ]),
  );
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    `---\nschema: task-package/v2\ntask_id: task_shared\ntitle: Shared ${label}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-08-19T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# Shared ${label}\n`,
  );
  writeFileSync(
    path.join(taskRoot, "facts.md"),
    `# Facts\n\n- {fact_id: F-ABCDEFGH, statement: ${label} observation, source: ${label}-source, observedAt: 2026-08-19T00:00:01.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: ${label}-session, boundAt: 2026-08-19T00:00:01.000Z}]}\n`,
  );
  const relation = {
    relation_id: deriveRelationId({
      source: "decision/dec_SHARED/C1",
      target: "fact/task_shared/F-ABCDEFGH",
      type: "evidenced-by",
      direction: "directed",
    }),
    source: "decision/dec_SHARED/C1",
    target: "fact/task_shared/F-ABCDEFGH",
    type: "evidenced-by",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: `${label} evidence`,
    state: "active",
  };
  writeFileSync(
    path.join(decisionRoot, "decision.md"),
    `---\nschema: decision-package/v1\ndecision_id: dec_SHARED\nworkspaceRevision: 1\ntitle: "Shared ${label} decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["daemon"],"productLines":["harness"]}\nproposedAt: "2026-08-19T00:00:00.000Z"\ndecidedAt: "2026-08-19T00:00:02.000Z"\nquestion: "Keep ${label}?"\nchosen: [{"id":"CH1","text":"Keep ${label}"}]\nrejected: [{"id":"RJ1","text":"Drop ${label}","whyNot":"History matters"}]\nclaims: [{"id":"C1","text":"${label} survives","loadBearing":true,"fulfillment":"evidenced"}]\nrelations: ${JSON.stringify([relation])}\n---\n\n# Shared ${label} decision\n`,
  );
}
export function sources(root: string): readonly string[] {
  commitSource(root);
  buildProjectionOracle(root);
  return [root];
}
export function sourcesWithoutProjection(root: string): readonly string[] {
  commitSource(root);
  return [root];
}
function commitSource(root: string): void {
  if (!statOrNull(path.join(root, ".git"))) {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Migration Source");
    git(root, "config", "user.email", "migration-source@example.invalid");
  }
  git(root, "add", ".");
  if (git(root, "diff", "--cached", "--name-only") !== "") git(root, "commit", "-qm", "source snapshot");
  const exclude = path.join(root, ".git/info/exclude"),
    currentExclude = readFileSync(exclude, "utf8");
  if (!currentExclude.split("\n").includes(".harness/")) writeFileSync(exclude, `${currentExclude}\n.harness/\n`);
}
export function snapshot(root: string): readonly string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === ".git" || entry.name === ".harness") return [];
      const target = path.join(dir, entry.name);
      return entry.isDirectory()
        ? walk(target)
        : [`${path.relative(root, target)}:${statSync(target).size}:${readFileSync(target, "utf8")}`];
    });
  return walk(root).sort();
}

export function buildProjectionOracle(root: string): void {
  const localRoot = path.join(root, ".harness/cache"),
    databasePath = path.join(localRoot, "task.sqlite"),
    taskRead = readMarkdownSource(root),
    cold = readLegacyMigrationSource(root);
  mkdirSync(localRoot, { recursive: true });
  rmSync(databasePath, { force: true });
  const database = new DatabaseSync(databasePath),
    statements = [
      "CREATE TABLE projection_meta(singleton INTEGER PRIMARY KEY, watermark INTEGER NOT NULL)",
      "CREATE TABLE task_snapshot(task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL)",
      "CREATE TABLE task_package(task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL)",
      "CREATE TABLE event_index(op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL UNIQUE, task_id TEXT, event_json TEXT NOT NULL)",
      "CREATE TABLE decision(decision_id TEXT PRIMARY KEY, state TEXT, title TEXT, question TEXT, risk_tier TEXT, urgency TEXT, vertical TEXT, preset TEXT, decision_class TEXT, applies_json TEXT, proposer_json TEXT, arbiter_json TEXT, proposed_at TEXT, decided_at TEXT, provenance_json TEXT, workspace_revision INTEGER NOT NULL)",
      "CREATE TABLE decision_option(decision_id TEXT NOT NULL, kind TEXT NOT NULL, option_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, rationale TEXT, workspace_revision INTEGER NOT NULL)",
      "CREATE TABLE decision_claim(decision_id TEXT NOT NULL, claim_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, load_bearing INTEGER NOT NULL, fulfillment TEXT, workspace_revision INTEGER NOT NULL)",
      "CREATE TABLE fact(fact_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL)",
      "CREATE TABLE relation_edge(relation_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL, state TEXT NOT NULL, owner_ref TEXT NOT NULL, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL)",
      "CREATE TABLE entity_projection(entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL)",
      "CREATE TABLE runtime_session(runtime_session_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL)",
    ];
  try {
    for (const statement of statements) database.exec(statement);
    let revision = 0;
    for (const entry of taskRead.entries) {
      const row = taskEntryToRow(root, entry),
        title = row.title || markdownH1(entry.body) || row.taskId,
        occurredAt =
          readScalar(entry.frontmatter, "  bindingCreatedAt") ||
          readScalar(entry.frontmatter, "bindingCreatedAt") ||
          readScalar(entry.frontmatter, "createdAt") ||
          "2026-01-01T00:00:00.000Z",
        packagePath = path.relative(path.join(root, "harness"), path.dirname(entry.indexPath)),
        task = {
          schema: "task/v2",
          taskId: row.taskId,
          title,
          taskClass: "standard",
          status: row.canonicalStatus,
          graph: REPLAY_TASK_GRAPH,
          currentNode: row.canonicalStatus === "in_review" ? "review" : "implementation",
          iteration: 0,
          pinned: false,
          packageDisposition: row.packageDisposition,
          createdBy: actor,
          completionGateIds: [],
          presetSnapshotDigest: null,
        };
      revision += 1;
      database
        .prepare("INSERT INTO task_snapshot VALUES (?, ?, ?)")
        .run(row.taskId, revision, JSON.stringify({ task }));
      database.prepare("INSERT INTO task_package VALUES (?, ?)").run(row.taskId, packagePath);
      database.prepare("INSERT INTO event_index VALUES (?, ?, ?, ?)").run(
        `fixture-task-${row.taskId}`,
        revision,
        row.taskId,
        JSON.stringify({
          eventId: `fixture-event-${row.taskId}`,
          occurredAt,
          workspaceRevision: revision,
        }),
      );
    }
    for (const decision of cold.decisions) {
      revision += 1;
      database
        .prepare("INSERT INTO decision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          decision.decisionId,
          decision.state,
          decision.title,
          decision.question,
          decision.riskTier,
          decision.urgency,
          decision.vertical,
          decision.preset,
          decision.decisionClass ?? "ordinary",
          JSON.stringify({ modules: decision.moduleKeys, productLines: decision.productLineKeys }),
          JSON.stringify(actor.principal),
          null,
          decision.proposedAt,
          decision.decidedAt,
          JSON.stringify([]),
          revision,
        );
      for (const [position, option] of decision.chosenRecords.entries())
        database
          .prepare("INSERT INTO decision_option VALUES (?, 'chosen', ?, ?, ?, ?, ?)")
          .run(decision.decisionId, option.id, position, option.text, option.rationale ?? null, revision);
      for (const [position, option] of decision.rejectedRecords.entries())
        database
          .prepare("INSERT INTO decision_option VALUES (?, 'rejected', ?, ?, ?, ?, ?)")
          .run(decision.decisionId, option.id, position, option.text, option.whyNot, revision);
      for (const [position, claim] of decision.claimRecords.entries())
        database
          .prepare("INSERT INTO decision_claim VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            decision.decisionId,
            claim.id,
            position,
            claim.text,
            claim.loadBearing ? 1 : 0,
            claim.fulfillment ?? null,
            revision,
          );
    }
    for (const fact of cold.facts) {
      revision += 1;
      // The active projection is keyed by fact_id. Legacy task-scoped duplicate
      // documents remain authored inputs, but only the first canonical fact ID
      // can be a same-cut projection witness.
      database.prepare("INSERT OR IGNORE INTO fact VALUES (?, ?, ?)").run(
        fact.factId,
        revision,
        JSON.stringify({
          taskId: fact.taskId,
          factId: fact.factId,
          statement: fact.statement,
          evidenceSource: fact.source,
          observedAt: fact.observedAt,
          confidence: fact.confidence,
          memoryClass: fact.memoryClass,
          memoryTags: fact.memoryTags,
          provenance: fact.provenance,
        }),
      );
    }
    for (const edge of cold.truth.edges) {
      revision += 1;
      const current = { ...edge, state: edge.state === "retired" ? "edge_retired" : edge.state };
      database
        .prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          current.relationId,
          current.sourceRef,
          current.targetRef,
          current.relationType,
          current.state,
          current.ownerRef,
          revision,
          JSON.stringify(current),
        );
    }
    for (const execution of fixtureExecutions(root)) {
      revision += 1;
      database
        .prepare("INSERT INTO entity_projection VALUES ('execution', ?, ?, ?)")
        .run(execution.id, revision, JSON.stringify(execution.fields));
    }
    database.prepare("INSERT INTO projection_meta VALUES (1, ?)").run(revision);
  } finally {
    database.close();
  }
}

function fixtureExecutions(root: string): readonly {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
}[] {
  const authored = path.join(root, "harness"),
    walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(target) : [target];
      });
  if (!statOrNull(path.join(authored, "tasks"))) return [];
  return walk(path.join(authored, "tasks"))
    .filter((target) => /^tasks\/[^/]+\/executions\/[^/]+\.md$/u.test(path.relative(authored, target)))
    .map((target) => {
      const body = readFileSync(target, "utf8");
      let fields: Readonly<Record<string, unknown>> = { body };
      try {
        const parsed = JSON.parse(body) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) fields = parsed;
      } catch {
        // A malformed execution remains a same-cut active witness and is archived by the importer.
      }
      const declared = fields.execution_id;
      return {
        id: typeof declared === "string" && declared.trim() ? declared : path.basename(target, ".md"),
        fields,
      };
    });
}

function markdownH1(body: string): string | null {
  return /^#\s+(.+)$/mu.exec(body)?.[1]?.trim() || null;
}
export function statOrNull(target: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}
export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function hierarchyFixture(root: string): void {
  const parentRoot = path.join(root, "harness/tasks/task_parent-root"),
    childRoot = path.join(root, "harness/tasks/task_child-leaf");
  mkdirSync(parentRoot, { recursive: true });
  mkdirSync(childRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const frontmatter = (taskId: string, title: string, extra: string): string =>
    `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: ${title}\n${extra}lifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# ${title}\n`;
  writeFileSync(path.join(parentRoot, "INDEX.md"), frontmatter("task_parent", "Parent milestone", ""));
  const relation = {
    relation_id: deriveRelationId({
      source: "task/task_child",
      target: "task/task_parent",
      type: "depends-on",
      direction: "directed",
    }),
    source: "task/task_child",
    target: "task/task_parent",
    type: "depends-on",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "The child cannot start before the parent lands.",
    state: "active",
  };
  writeFileSync(
    path.join(childRoot, "INDEX.md"),
    frontmatter("task_child", "Child work", `parent: task_parent\nrelations: ${JSON.stringify([relation])}\n`),
  );
}

export function legacyRelationTypeFixture(root: string): void {
  const authored = path.join(root, "harness"),
    eventsRoot = path.join(authored, "events"),
    factTaskRoot = path.join(authored, "tasks/task_relation-fixture");
  mkdirSync(eventsRoot, { recursive: true });
  writeFileSync(
    path.join(authored, "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const task = (taskId: string, title: string): void => {
    const taskRoot = path.join(authored, `tasks/${taskId}-fixture`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: ${title}\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-07-05T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# ${title}\n`,
    );
  };
  task("task_relation", "Relation evidence");
  task("task_01KWPY434ZHW6ADS2TBC1N8TX6", "Two-gate resolution");
  task("task_01KWMC7H04ZRY0VZ5MRR6M4XVQ", "M5 exit");
  writeFileSync(
    path.join(factTaskRoot, "facts.md"),
    [
      "# Facts",
      "",
      "- {fact_id: F-HKPMAP7K, statement: The current-state gap is observed, source: legacy-test, observedAt: 2026-07-05T00:00:01.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-07-05T00:00:01.000Z}]}",
      "- {fact_id: F-96WCR25Q, statement: The usability gate failed, source: legacy-test, observedAt: 2026-07-05T00:00:02.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-07-05T00:00:02.000Z}]}",
      "",
    ].join("\n"),
  );
  const decision = (decisionId: string, title: string): void => {
    const decisionRoot = path.join(authored, `decisions/decision-${decisionId}`);
    mkdirSync(decisionRoot, { recursive: true });
    writeFileSync(
      path.join(decisionRoot, "decision.md"),
      `---\nschema: decision-package/v1\ndecision_id: ${decisionId}\nworkspaceRevision: 1\ntitle: "${title}"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["kernel"],"productLines":["harness"]}\nproposedAt: "2026-07-05T00:00:00.000Z"\ndecidedAt: "2026-07-05T00:00:03.000Z"\nquestion: "How should the legacy relation read?"\nchosen: [{"id":"CH1","text":"Use the canonical sentence"}]\nrejected: [{"id":"RJ1","text":"Keep the legacy verb","whyNot":"The sentence reads incorrectly"}]\nclaims: [{"id":"C1","text":"The canonical sentence is deterministic","loadBearing":false,"fulfillment":null}]\nrelations: []\n---\n\n# ${title}\n`,
    );
  };
  decision("dec_F2_ACCEPT_RECKON", "Accept and reckon");
  decision("dec_M5_E76_CLI_AGENT_ERGONOMICS", "CLI ergonomics");
  decision("dec_VERT_DECISION_CONFORMANCE_PRESET", "Decision conformance preset");
  const samples = legacyRelationTypeSamples();
  for (const sample of samples) {
    const relation = {
        direction: "directed",
        origin: "imported_snapshot",
        ...sample.relation,
        state: "edge_retired",
        strength: "strong",
      },
      event = {
        actor: { executor: null, principal: { personId: "person_zeyu" } },
        eventId: sample.eventId,
        occurredAt: sample.occurredAt,
        opId: sample.opId,
        payload: {
          entity: { kind: "relation", ownerRef: sample.ownerRef, relation },
          generation: "v0",
          migratedFrom: relation.relation_id,
        },
        schema: "migration-import-event/v1",
        source: "migration-import/v1",
        type: "entity_migrated",
        workspaceRevision: sample.workspaceRevision,
      },
      shardRoot = path.join(eventsRoot, sample.eventId.slice(6, 8));
    mkdirSync(shardRoot, { recursive: true });
    writeFileSync(path.join(shardRoot, `${sample.opId}.json`), `${JSON.stringify(event)}\n`);
  }
}

export function legacyRelationCanonicalCollisionFixture(root: string): void {
  legacyRelationTypeFixture(root);
  const event = {
      actor: { executor: null, principal: { personId: "person_zeyu" } },
      eventId: "event-381f1232974e15959102c494713c5a962a1be4dc13a8dc7cea127c0395ae512b",
      occurredAt: "2026-08-15T18:13:55.397Z",
      opId: "migration-089bbfd780c1f15cf2460e3aaf",
      payload: {
        entity: {
          kind: "relation",
          ownerRef: "decision/dec_VERT_DECISION_CONFORMANCE_PRESET",
          relation: {
            direction: "directed",
            origin: "imported_snapshot",
            rationale:
              "M5 exit 实证驱动: F5 shipped-unused/docmap 手写漂移/模板旧名回归全靠人工 ledger-walk 抓到, " +
              "该 SOP 应产品化为可调用 preset",
            relation_id: "rel_6f93a31e553e4620",
            source: "decision/dec_VERT_DECISION_CONFORMANCE_PRESET/CH1",
            state: "active",
            strength: "strong",
            target: "task/task_01KWMC7H04ZRY0VZ5MRR6M4XVQ",
            type: "relates",
          },
        },
        generation: "v0",
        migratedFrom: "rel_6f93a31e553e4620",
      },
      schema: "migration-import-event/v1",
      source: "migration-import/v1",
      type: "entity_migrated",
      workspaceRevision: 3455,
    },
    eventsRoot = path.join(root, "harness/events/38");
  mkdirSync(eventsRoot, { recursive: true });
  writeFileSync(path.join(eventsRoot, `${event.opId}.json`), `${JSON.stringify(event)}\n`);
}

function legacyRelationTypeSamples(): readonly {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly ownerRef: string;
  readonly relation: {
    readonly relation_id: string;
    readonly source: string;
    readonly type: string;
    readonly target: string;
    readonly rationale: string;
  };
}[] {
  return [
    {
      eventId: "event-de2b5ef743854252cdcac0069219d470f769330ebcd16edca4f753aee56a0d4f",
      occurredAt: "2026-08-15T18:13:55.390Z",
      opId: "migration-af95353e79118ac44f53c3b9a9",
      workspaceRevision: 2826,
      ownerRef: "decision/dec_F2_ACCEPT_RECKON",
      relation: {
        relation_id: "rel_636599ba3973f841",
        source: "decision/dec_F2_ACCEPT_RECKON/C1",
        type: "supports",
        target: "fact/F-HKPMAP7K",
        rationale:
          "The investigation fact establishes the current-state gap and the open F2 fork this decision closes.",
      },
    },
    {
      eventId: "event-66a3f6cf1e9cb936fa957ea3a1fddd37988265b9359a6a8bbca242f485d204da",
      occurredAt: "2026-08-15T18:13:55.390Z",
      opId: "migration-d446b4d07704f3677679c9174e",
      workspaceRevision: 2827,
      ownerRef: "decision/dec_F2_ACCEPT_RECKON",
      relation: {
        relation_id: "rel_095e276c89f4d1bb",
        source: "decision/dec_F2_ACCEPT_RECKON/CH1",
        type: "implements",
        target: "task/task_01KWPY434ZHW6ADS2TBC1N8TX6",
        rationale:
          "This task implements the two-gate resolution: accept evidence floor + reckon coverage verdict + " +
          "load_bearing claim field + docs correction.",
      },
    },
    {
      eventId: "event-9e02f1e659d7786aa909ed0f0a37d2750d13c330702c09557db9c5379a9d706d",
      occurredAt: "2026-08-15T18:13:55.391Z",
      opId: "migration-796488fd3411f144d1fe6f09b8",
      workspaceRevision: 2927,
      ownerRef: "decision/dec_M5_E76_CLI_AGENT_ERGONOMICS",
      relation: {
        relation_id: "rel_2668a668af28a0eb",
        source: "decision/dec_M5_E76_CLI_AGENT_ERGONOMICS/C1",
        type: "refines",
        target: "fact/F-96WCR25Q",
        rationale: "使用性门 FAIL:E76 人体工学基线未达(seeded 旧名/graph 未 provision/closeout 不可发现)",
      },
    },
    {
      eventId: "event-76af3a443c01443c2c6685ca201624ed530a2ba60a71f8b90fbcdcf23c80f333",
      occurredAt: "2026-08-15T18:13:55.397Z",
      opId: "migration-40082fe475ee27f0817cfeb348",
      workspaceRevision: 3456,
      ownerRef: "decision/dec_VERT_DECISION_CONFORMANCE_PRESET",
      relation: {
        relation_id: "rel_cf7cc37fa3d2fa51",
        source: "decision/dec_VERT_DECISION_CONFORMANCE_PRESET/CH1",
        type: "supports",
        target: "task/task_01KWMC7H04ZRY0VZ5MRR6M4XVQ",
        rationale:
          "M5 exit 实证驱动: F5 shipped-unused/docmap 手写漂移/模板旧名回归全靠人工 ledger-walk 抓到, " +
          "该 SOP 应产品化为可调用 preset",
      },
    },
  ];
}

export function illegalRelationFixture(root: string): void {
  const taskRoot = path.join(root, "harness/tasks/task_evidence-holder"),
    decisionRoot = path.join(root, "harness/decisions/decision-dec_MATRIX");
  mkdirSync(taskRoot, { recursive: true });
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    "---\nschema: task-package/v2\ntask_id: task_evidence\ntitle: Evidence holder\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Evidence holder\n",
  );
  writeFileSync(
    path.join(taskRoot, "facts.md"),
    "# Facts\n\n- {fact_id: F-ABCDEFGH, statement: Observed migration, source: legacy-test, observedAt: 2026-01-02T00:00:00.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-01-02T00:00:00.000Z}]}\n",
  );
  const edge = (type: string, rationale: string) => ({
    relation_id: deriveRelationId({
      source: "decision/dec_MATRIX/C1",
      target: "fact/task_evidence/F-ABCDEFGH",
      type,
      direction: "directed",
    }),
    source: "decision/dec_MATRIX/C1",
    target: "fact/task_evidence/F-ABCDEFGH",
    type,
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale,
    state: "active",
  });
  // There is no historical decision that maps decision --blocks--> fact.
  const relations = [
    edge("evidenced-by", "The observation evidences the claim."),
    edge("blocks", "This malformed historical edge needs a human decision."),
  ];
  writeFileSync(
    path.join(decisionRoot, "decision.md"),
    `---\nschema: decision-package/v1\ndecision_id: dec_MATRIX\nworkspaceRevision: 3\ntitle: "Matrix decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["kernel"],"productLines":["harness"]}\nproposedAt: "2026-01-01T12:00:00.000Z"\ndecidedAt: "2026-01-03T00:00:00.000Z"\nquestion: "Does the matrix hold?"\nchosen: [{"id":"CH1","text":"Hold it"}]\nrejected: [{"id":"RJ1","text":"Widen it","whyNot":"Historical dirt must not become product logic"}]\nclaims: [{"id":"C1","text":"Only allowed triples migrate","loadBearing":true,"fulfillment":"evidenced"}]\nrelations: ${JSON.stringify(relations)}\n---\n\n# Matrix decision\n\nPreserved prose.\n`,
  );
}

export function orphanEndpointFixture(root: string): void {
  const goodRoot = path.join(root, "harness/tasks/task_good"),
    orphanRoot = path.join(root, "harness/tasks/task_orphan");
  mkdirSync(goodRoot, { recursive: true });
  mkdirSync(orphanRoot, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const relation = {
    relation_id: deriveRelationId({
      source: "task/task_good",
      target: "task/task_orphan",
      type: "depends-on",
      direction: "directed",
    }),
    source: "task/task_good",
    target: "task/task_orphan",
    type: "depends-on",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "The good task depends on a package that cannot migrate.",
    state: "active",
  };
  writeFileSync(
    path.join(goodRoot, "INDEX.md"),
    `---\nschema: task-package/v2\ntask_id: task_good\ntitle: Good task\nrelations: ${JSON.stringify([relation])}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# Good task\n`,
  );
  writeFileSync(path.join(orphanRoot, "INDEX.md"), "# missing frontmatter so this package cannot migrate\n");
}

export function attributionFixture(root: string): void {
  const owned = path.join(root, "harness/tasks/task_owned"),
    unowned = path.join(root, "harness/tasks/task_unowned"),
    attribution = path.join(root, "harness/attribution-events"),
    authorityWitnesses = path.join(root, "harness/audit-witnesses");
  mkdirSync(owned, { recursive: true });
  mkdirSync(unowned, { recursive: true });
  mkdirSync(attribution, { recursive: true });
  mkdirSync(authorityWitnesses, { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const pkg = (taskId: string, title: string): string =>
    `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: ${title}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# ${title}\n`;
  writeFileSync(path.join(owned, "INDEX.md"), pkg("task_owned", "Task with recorded attribution"));
  writeFileSync(path.join(unowned, "INDEX.md"), pkg("task_unowned", "Task with no attribution record"));
  // The earliest record for an entity is its creation attribution. `principal.kind` exists in the
  // legacy shape and must be dropped: the current identity contract accepts personId only.
  const line = (at: string, executorId: string): string =>
    JSON.stringify({
      schema: "attribution-event/v1",
      entityId: "task/task_owned",
      kind: "package_create",
      actor: {
        principal: { kind: "person", personId: "person_original" },
        executor: { kind: "agent", id: executorId },
      },
      at,
    });
  writeFileSync(
    path.join(attribution, "aa.jsonl"),
    `${line("2026-01-05T00:00:00.000Z", "later-agent")}\n${line("2026-01-01T00:00:00.000Z", "codex")}\n`,
  );
  writeFileSync(
    path.join(authorityWitnesses, "authority.jsonl"),
    `${JSON.stringify({ schema: "attribution-event/v2", mutationSet: { mutations: [] }, actorAxesBinding: { principalPersonId: "person_original" } })}\n`,
  );
}
