const OPERATIONS_BY_KIND = {
  adopt: ["multica"],
  audit: ["provenance"],
  authority: ["cutover status", "cutover drain", "cutover scan", "cutover confirm", "cutover boundary", "cutover freeze", "cutover re-enable", "repo enroll", "repo resign"],
  cas: ["gc"],
  check: ["check"],
  consent: [],
  daemon: ["register", "start", "status", "logs", "stop", "restart", "refresh", "upgrade"],
  decision: ["list", "show", "verify", "repin", "propose", "transition", "amend", "relate", "reckon"],
  diagnostics: ["command-usage"],
  distill: ["candidate", "promote"],
  doc: ["status", "sync"],
  doctor: ["doctor"],
  event: ["append", "list"],
  execution: ["show", "list"],
  external: ["snapshot", "list github"],
  fact: ["list", "show", "record", "invalidate"],
  git: ["diff"],
  governance: ["rebuild"],
  graph: ["graph"],
  gui: ["gui"],
  init: ["init"],
  legacy: ["scan", "plan", "copy-docs", "index", "verify"],
  materializer: ["run"],
  migrate: ["plan", "structure", "anchors", "fact-execution", "retired-attribution-fields", "provenance", "run", "verify"],
  module: ["list", "inspect", "register", "scaffold", "unregister", "step"],
  preset: ["validate", "list", "inspect", "check", "install", "seed", "audit", "uninstall", "entrypoint"],
  relation: ["list", "relation retire", "relation replace"],
  review: ["show"],
  script: ["list", "inspect", "run"],
  session: ["show", "export", "backfill", "sync"],
  status: ["status"],
  task: ["retire-execution", "submit", "create", "start", "holder", "release", "closeout", "transition", "progress append", "artifact add", "amend", "contract migrate", "archive", "supersede", "delete", "reopen", "code-doc reconcile", "review", "consent-record", "review-execution", "complete", "show", "relate", "list"],
  template: ["list", "render"],
  vertical: ["validate"],
  worktree: ["create", "status"]
};

const LIFECYCLE_IDS = new Set([
  "authority.cutover-drain", "authority.cutover-scan", "authority.cutover-confirm",
  "authority.cutover-boundary", "authority.cutover-freeze", "authority.cutover-re-enable",
  "authority.repo-enroll", "authority.repo-resign",
  "daemon.register", "daemon.start", "daemon.stop", "daemon.restart", "daemon.refresh", "daemon.upgrade",
  "gui.gui", "init.init", "legacy.copy-docs", "legacy.index",
  "migrate.structure", "migrate.anchors", "migrate.fact-execution",
  "migrate.retired-attribution-fields", "migrate.provenance", "migrate.run",
  "preset.entrypoint", "script.run", "task.archive", "task.closeout", "task.complete",
  "task.delete", "task.reopen", "task.start", "task.submit", "task.supersede",
  "task.transition", "worktree.create"
]);

const READ_IDS = new Set([
  "audit.provenance", "authority.cutover-status", "check.check", "daemon.logs", "daemon.status",
  "decision.list", "decision.show", "decision.verify", "diagnostics.command-usage", "doc.status",
  "doctor.doctor", "event.list", "execution.list", "execution.show", "external.list-github",
  "external.snapshot", "fact.list", "fact.show", "git.diff", "graph.graph", "legacy.plan",
  "legacy.scan", "legacy.verify", "migrate.plan", "migrate.verify", "module.inspect", "module.list",
  "preset.audit", "preset.check", "preset.inspect", "preset.list", "preset.validate", "relation.list",
  "review.show", "script.inspect", "script.list", "session.show", "status.status", "task.holder",
  "task.list", "task.review", "task.show", "template.list", "template.render", "vertical.validate",
  "worktree.status"
]);

const EXCLUDED = new Map([
  ["adopt.multica", "Requires a reachable, configured Multica provider and a real external issue; cold-start is intentionally offline."],
  ["external.snapshot", "Requires a reachable configured GitHub or Multica provider; cold-start is intentionally offline."],
  ["external.list-github", "Requires a reachable configured GitHub provider and repository; cold-start is intentionally offline."],
  ["gui.gui", "Launches the Electron desktop controller and requires an interactive display/event loop, not a headless CLI fixture."],
  ["decision.repin", "Only applies to a pre-existing verified stale decision pin and requires migration evidence; fresh decisions are correctly pinned."],
  ["daemon.upgrade", "Requires a managed daemon deployment, versioned snapshot build, and supervisor convergence; a disposable project daemon is not that deployment boundary."],
  ["authority.cutover-drain", "Belongs to an explicit production V1-to-V2 authority cutover campaign; init creates a fresh V2 authority with no V1 admission backlog."],
  ["authority.cutover-scan", "Requires a drained production cutover campaign and independent final-scan evidence; a fresh V2 repo has no cutover campaign."],
  ["authority.cutover-confirm", "Requires two persisted production cutover scans; a fresh V2 repo has no cutover campaign."],
  ["authority.cutover-boundary", "Activates a production cutover boundary from confirmed scan equality; init already creates the fresh V2 boundary."],
  ["authority.cutover-freeze", "Freezes a previously activated production cutover boundary; no such migration boundary exists after fresh init."],
  ["authority.cutover-re-enable", "Re-enables a frozen production cutover after a verified forward fix; a fresh init has neither freeze nor forward-fix incident."],
  ["authority.repo-enroll", "Administrative adoption of a pre-existing repository into a trust domain; ha init already enrolls the cold-start repository."],
  ["authority.repo-resign", "Administrative trust-domain rotation for an already enrolled repository; cold-start has no prior domain to retire."],
  ...["scan", "plan", "copy-docs", "index", "verify"].map((op) => [
    `legacy.${op}`,
    "Legacy Intake requires a pre-Harness source tree; a genuinely fresh project intentionally has no legacy content."
  ]),
  ...["plan", "structure", "anchors", "fact-execution", "retired-attribution-fields", "provenance", "run", "verify"].map((op) => [
    `migrate.${op}`,
    "Migration tooling requires historical schema/session/attribution data; a freshly initialized workspace intentionally has none."
  ])
]);

const TASK_REQUIRED = new Set([
  "audit.provenance", "decision.reckon", "distill.candidate", "distill.promote", "execution.list",
  "fact.invalidate", "fact.list", "fact.record", "fact.show", "preset.entrypoint", "task.amend",
  "task.archive", "task.artifact-add", "task.closeout", "task.code-doc-reconcile", "task.complete",
  "task.consent-record", "task.delete", "task.holder", "task.progress-append", "task.relate",
  "task.release", "task.reopen", "task.retire-execution", "task.review", "task.review-execution",
  "task.show", "task.start", "task.submit", "task.supersede", "task.transition", "worktree.create",
  "worktree.status"
]);

const DECISION_REQUIRED = new Set([
  "decision.amend", "decision.reckon", "decision.relate", "decision.repin", "decision.show",
  "decision.transition", "decision.verify", "relation.relation-replace", "relation.relation-retire"
]);

const EXECUTION_REQUIRED = new Set([
  "audit.provenance", "execution.show", "review.show", "task.closeout", "task.complete",
  "task.consent-record", "task.release", "task.retire-execution", "task.review-execution", "task.submit"
]);

const DAEMON_REQUIRED = new Set([
  "audit.provenance", "authority.cutover-status", "authority.cutover-drain", "authority.cutover-scan",
  "authority.cutover-confirm", "authority.cutover-boundary", "authority.cutover-freeze",
  "authority.cutover-re-enable", "daemon.logs", "daemon.restart", "daemon.refresh", "daemon.status",
  "daemon.stop", "daemon.upgrade", "decision.amend", "decision.propose", "decision.reckon",
  "decision.relate", "decision.repin", "decision.transition", "distill.promote", "doc.sync",
  "fact.invalidate", "fact.record", "governance.rebuild", "materializer.run", "module.register",
  "module.scaffold", "module.step", "module.unregister", "preset.entrypoint", "preset.install",
  "preset.seed", "preset.uninstall", "relation.relation-replace", "relation.relation-retire",
  "script.run", "task.amend", "task.archive", "task.artifact-add", "task.closeout",
  "task.code-doc-reconcile", "task.complete", "task.consent-record", "task.contract-migrate",
  "task.create", "task.delete", "task.progress-append", "task.relate", "task.release", "task.reopen",
  "task.retire-execution", "task.review-execution", "task.start", "task.submit", "task.supersede",
  "task.transition", "worktree.create"
]);

export function operationId(kind, name) {
  return `${kind}.${name.replaceAll(" ", "-")}`;
}

export const coldstartOperationManifest = Object.entries(OPERATIONS_BY_KIND).flatMap(([kind, names]) =>
  names.map((name) => {
    const id = operationId(kind, name);
    const prerequisites = id === "init.init" ? [] : ["initialized-workspace"];
    if (TASK_REQUIRED.has(id)) prerequisites.push("task");
    if (DECISION_REQUIRED.has(id)) prerequisites.push("decision");
    if (EXECUTION_REQUIRED.has(id)) prerequisites.push("execution");
    if (["task.closeout", "task.complete", "task.review-execution"].includes(id)) prerequisites.push("submitted-execution", "human-consent");
    if (id.startsWith("session.")) prerequisites.push("isolated-runtime-session");
    if (id.startsWith("preset.") || id.startsWith("script.")) prerequisites.push("installed-extension");
    return {
      id,
      kind,
      op: name,
      category: LIFECYCLE_IDS.has(id) ? "lifecycle" : READ_IDS.has(id) ? "read" : "write",
      prerequisites: [...new Set(prerequisites)],
      daemonRequired: DAEMON_REQUIRED.has(id),
      excludedByDesign: EXCLUDED.get(id) ?? null
    };
  })
);
