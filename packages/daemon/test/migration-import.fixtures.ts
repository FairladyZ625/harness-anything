import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveRelationId, sha256Text } from "../../kernel/src/index.ts";
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
  if (!statOrNull(path.join(root, ".git"))) {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Migration Source");
    git(root, "config", "user.email", "migration-source@example.invalid");
  }
  git(root, "add", ".");
  if (git(root, "diff", "--cached", "--name-only") !== "") git(root, "commit", "-qm", "source snapshot");
  return [root];
}
export function snapshot(root: string): readonly string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === ".git") return [];
      const target = path.join(dir, entry.name);
      return entry.isDirectory()
        ? walk(target)
        : [`${path.relative(root, target)}:${statSync(target).size}:${readFileSync(target, "utf8")}`];
    });
  return walk(root).sort();
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
  // `supports` was the pre-2026-07-05 spelling of this edge; the current matrix only accepts evidenced-by.
  const relations = [
    edge("evidenced-by", "The observation evidences the claim."),
    edge("supports", "Legacy spelling of the same evidence edge."),
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
