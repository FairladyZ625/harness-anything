// Coverage table for tools/scale/cli-entity-bench.mjs. An entry is either a sample builder
// `(c, s) => argv` or a string naming why the command is not measured. Entries run in table
// order once per sample s, so a chain command reads what its producer returned for the same s
// through c.got(id, s). Registry ids missing from this table are reported as unmapped.

const worker = { actor: "agent:scale-bench-worker" },
  reviewer = { actor: "agent:scale-bench-reviewer" },
  offline = { offline: true };
const J = JSON.stringify;
const runtime = "spawns a real agent runtime process";
const artifactKinds = ["research", "architecture-decision-record", "external-issue"];

export const benchKinds = artifactKinds;

export const decisionPacket = (title, text) =>
  J({
    title,
    question: `Should ${title} hold?`,
    riskTier: "medium",
    urgency: "medium",
    vertical: "default",
    preset: "default",
    decisionClass: "ordinary",
    appliesTo: { modules: ["kernel"], productLines: [] },
    chosen: [{ id: "CH1", text }],
    rejected: [{ id: "RJ1", text: "Keep the old path", whyNot: "Not canonical" }],
    claims: [],
    fulfillments: [],
  });

// A fresh package reaches the worktree asynchronously; wait for it before writing into it.
const visible = (metric) => (c, s) => {
  const opId = c.got.get(`${metric}#${s}`)?.opId ?? "none";
  return ["receipt", "show", opId, "--wait", "worktree_visible", "--timeout-ms", "60000"];
};
const chain = (s) => `bench-chain-${s}`,
  chain2 = (s) => `bench-chain2-${s}`,
  chain3 = (s) => `bench-chain3-${s}`;

const entityEntries = artifactKinds.flatMap((kind) => [
  [`entity-import~${kind}`, (c, s) => c.importArgs(kind, `probe-${s}`)],
  [`entity-get~${kind}`, (c, s) => ["entity", "get", kind, "--id", c.id(`entity-import~${kind}`, s)]],
  [`entity-list~${kind}`, () => ["entity", "list", kind]],
  [
    `entity-update~${kind}`,
    (c, s) => [
      ...["entity", "update", kind, "--id", c.id(`entity-import~${kind}`, s), "--title", c.text(`upd ${kind} ${s}`)],
      ...["--expected-version", c.rev(`entity-import~${kind}`, s)],
    ],
  ],
  [
    `entity-archive~${kind}`,
    (c, s) => [
      ...["entity", "archive", kind, "--id", c.id(`entity-import~${kind}`, s), "--reason", "bench"],
      ...["--expected-version", c.rev(`entity-update~${kind}`, s)],
    ],
  ],
  [`entity-import~delete-${kind}`, (c, s) => c.importArgs(kind, `del-${s}`)],
  [
    `entity-delete~${kind}`,
    (c, s) => [
      ...["entity", "delete", kind, "--id", c.id(`entity-import~delete-${kind}`, s), "--reason", "bench"],
      ...["--expected-version", c.rev(`entity-import~delete-${kind}`, s)],
    ],
  ],
  [`entity-get~deleted-${kind}`, (c, s) => ["entity", "get", kind, "--id", c.id(`entity-import~delete-${kind}`, s)]],
]);

export const commandTable = [
  // Task lifecycle, one chain Task per sample.
  [
    "task-create",
    (c, s) => ["task", "create", "--id", chain(s), "--admin", "--title", `Chain ${s}`, "--preset", "docs-task"],
  ],
  ["task-show", (c, s) => ["task", "show", chain(s)]],
  ["task-read-set", (c, s) => ["task", "read-set", chain(s)]],
  ["task-dispatches", (c, s) => ["task", "dispatches", chain(s)]],
  ["task-amend", (c, s) => ["task", "amend", chain(s), "--set", `title:Chain ${s} amended`]],
  ["task-pin", (c, s) => ["task", "pin", chain(s)]],
  ["task-unpin", (c, s) => ["task", "unpin", chain(s)]],
  ["receipt-show~visible", visible("task-create")],
  ["doc-sync-submit~plan", (c, s) => ["doc", "sync", "--submit", "--path", c.realizePlan(s)]],
  ["task-start", (c, s) => ["task", "start", chain(s), "--execution-id", `exe-chain-${s}`], worker],
  ["task-progress-append", (c, s) => ["task", "progress", "append", chain(s), "--text", c.text("progress")], worker],
  [
    "task-artifact-add",
    (c, s) => [
      ...["task", "artifact", "add", chain(s), "--source", c.repoFile(`src-${s}.md`, `# a ${s}\n`)],
      ...["--destination", `artifacts/bench-${s}.md`],
    ],
    worker,
  ],
  ["doc-status", (c, s) => ["doc", "status", "--task", chain(s)]],
  ["doc-sync-dry-run", (c, s) => (c.writeCloseout(s), ["doc", "sync", "--dry-run", "--task", chain(s)])],
  ["doc-sync-submit", (c, s) => ["doc", "sync", "--submit", "--task", chain(s)], worker],
  ["doc-show", (c, s) => ["doc", "show", "--path", `${c.packagePath(s)}/closeout.md`]],
  [
    "fact-record~chain",
    (c, s) => ["fact", "record", chain(s), "--statement", c.text(`chain fact ${s}`), "--source", "bench"],
  ],
  ["task-submit", (c, s) => ["task", "submit", chain(s)], worker],
  ["task-code-doc-reconcile", (c, s) => ["task", "code-doc", "reconcile", chain(s), "--path", "README.md"]],
  ["task-show~witness", (c, s) => ["task", "show", chain(s)]],
  ["task-review", (c, s) => ["task", "review", chain(s)]],
  [
    "task-review-execution",
    (c, s) => ["task", "review-execution", chain(s), "--review-id", `rev-${s}`, "--json-input", J(c.review(s))],
    reviewer,
  ],
  ["task-review-consent", (c, s) => ["task", "review-consent", chain(s), "--review-id", `rev-${s}`], worker],
  ["task-complete", (c, s) => ["task", "complete", chain(s), "--consent"], worker],
  [
    "task-code-doc-repoint",
    (c, s) => [
      "task",
      "code-doc",
      "repoint",
      chain(s),
      "--record",
      c.field("task-show~witness", s, "witnessId"),
      "--reason",
      "b",
    ],
  ],
  // Chain 2 uses an independent artifact reviewer; chain 3 walks the non-happy transitions.
  [
    "task-create~chain2",
    (c, s) => ["task", "create", "--id", chain2(s), "--admin", "--title", `Chain2 ${s}`, "--preset", "docs-task"],
  ],
  ["receipt-show~visible2", visible("task-create~chain2")],
  ["doc-sync-submit~plan2", (c, s) => ["doc", "sync", "--submit", "--path", c.realizePlan(s, "~chain2")]],
  ["task-start~chain2", (c, s) => ["task", "start", chain2(s), "--execution-id", `exe-chain2-${s}`], worker],
  [
    "doc-sync-submit~chain2",
    (c, s) => (c.writeCloseout(s, "~chain2"), ["doc", "sync", "--submit", "--task", chain2(s)]),
    worker,
  ],
  [
    "fact-record~chain2",
    (c, s) => ["fact", "record", chain2(s), "--statement", c.text(`chain2 fact ${s}`), "--source", "bench"],
  ],
  ["task-submit~chain2", (c, s) => ["task", "submit", chain2(s)], worker],
  [
    "task-review-execution~chain2",
    (c, s) => [
      "task",
      "review-execution",
      chain2(s),
      "--review-id",
      `rev-chain2-${s}`,
      "--json-input",
      J(c.review(s, "~chain2")),
    ],
    reviewer,
  ],
  ["task-complete~chain2", (c, s) => ["task", "complete", chain2(s), "--consent"], worker],
  ["task-create~chain3", (c, s) => ["task", "create", "--id", chain3(s), "--admin", "--title", `Chain3 ${s}`]],
  ["receipt-show~visible3", visible("task-create~chain3")],
  ["doc-sync-submit~plan3", (c, s) => ["doc", "sync", "--submit", "--path", c.realizePlan(s, "~chain3")]],
  ["task-start~chain3", (c, s) => ["task", "start", chain3(s), "--execution-id", `exe-chain3-${s}`], worker],
  ["task-release", (c, s) => ["task", "release", chain3(s), "--reason", "bench"], worker],
  ["task-transition", (c, s) => ["task", "transition", chain3(s), "blocked", "--reason", "bench"]],
  ["task-declare-executor", (c, s) => ["task", "declare-executor", chain3(s), "--reason", "bench"]],
  ["task-archive", (c, s) => ["task", "archive", chain3(s), "--reason", "bench"]],
  ["task-reopen", (c, s) => ["task", "reopen", chain3(s), "--reason", "bench reopen"]],
  [
    "task-supersede",
    (c, s) => ["task", "supersede", c.task(s + 1), "--title", `Replacement ${s}`, "--reason", "bench"],
  ],
  ["task-delete", (c, s) => ["task", "delete", "--soft", c.task(s + 20), "--confirm", c.task(s + 20), "--reason", "b"]],
  ["task-contract-migrate", () => ["task", "contract", "migrate", "--dry-run"]],
  ["task-list", () => ["task", "list"]],
  ["task-list~status", () => ["task", "list", "--status", "planned"]],
  ["task-list~search", (c) => ["task", "list", "--search", c.task(7)]],
  ["task-list~kind", () => ["task", "list", "--kind", "docs"]],
  ["agenda", () => ["agenda"]],
  ["agenda~page", () => ["agenda", "--limit", "20"]],
  // Facts.
  ["fact-record", (c, s) => ["fact", "record", c.task(s), "--statement", c.text(`fact ${s}`), "--source", "bench"]],
  ["fact-show", (c, s) => ["fact", "show", "--id", c.id("fact-record", s)]],
  ["fact-search", () => ["fact", "search", "bench"]],
  ["fact-search~task", (c, s) => ["fact", "search", "--task", c.task(s)]],
  ["fact-type-register", (c, s) => ["fact", "type", "register", `bench-type-${s}`, "--source", "bench"]],
  ["fact-type-list", () => ["fact", "type", "list"]],
  [
    "fact-reclassify",
    (c, s) => ["fact", "reclassify", c.id("fact-record", s), "--type", `bench-type-${s}`, "--rationale", "bench"],
  ],
  [
    "distill-candidate",
    (c, s) => [
      "distill",
      "candidate",
      "--task",
      c.task(s),
      "--input",
      c.repoFile(`distill-${s}.md`, `# Distill ${s}\n\n- ${c.text("claim")}\n`),
    ],
  ],
  [
    "distill-promote",
    (c, s) => [
      ...["distill", "promote", "--task", c.task(s), "--candidate", c.field("distill-candidate", s, "candidatePath")],
      ...["--claim", c.text("distilled")],
    ],
  ],
  // Decisions.
  [
    "decision-propose",
    (c, s) => [
      "decision",
      "propose",
      "--json-input",
      decisionPacket(`Probe ${s}`, c.text("d")),
      "--body",
      c.decisionBody(s),
    ],
  ],
  ["decision-show", (c, s) => ["decision", "show", c.id("decision-propose", s)]],
  ["decision-list", () => ["decision", "list"]],
  ["decision-list~state", () => ["decision", "list", "--state", "proposed"]],
  ["decision-validate", (c, s) => ["decision", "validate", c.id("decision-propose", s)]],
  ["decision-verify", (c, s) => ["decision", "verify", c.id("decision-propose", s)]],
  ["decision-amend", (c, s) => ["decision", "amend", c.id("decision-propose", s), "--title", `Probe ${s} v2`]],
  [
    "decision-claim-add",
    (c, s) => ["decision", "claim", "add", c.id("decision-propose", s), "--id", "C1", "--text", c.text("claim")],
  ],
  ["decision-reckon", (c, s) => ["decision", "reckon", c.id("decision-propose", s), "--task", c.task(s)]],
  [
    "relation-relate~evidence",
    (c, s) => [
      ...["relation", "relate", "--source-ref", `decision/${c.id("decision-propose", s)}/C1`],
      ...[
        "--target-ref",
        `fact/${c.id("fact-record", s)}`,
        "--type",
        "evidenced-by",
        "--rationale",
        "b",
        "--expected-version",
        "0",
      ],
    ],
  ],
  ["decision-accept", (c, s) => ["decision", "accept", c.id("decision-propose", s), "--rationale", "bench"]],
  [
    "decision-claim-fulfill",
    (c, s) => ["decision", "claim", "fulfill", c.id("decision-propose", s), "--id", "C1", "--mode", "delivered"],
  ],
  ["decision-transition", (c, s) => ["decision", "transition", "deferred", c.decision(s), "--dry-run"]],
  ["decision-defer", (c, s) => ["decision", "defer", c.decision(s + 10), "--rationale", "bench"]],
  ["decision-reject", (c, s) => ["decision", "reject", c.decision(s + 20), "--rationale", "bench"]],
  [
    "decision-propose~b",
    (c, s) => [
      "decision",
      "propose",
      "--json-input",
      decisionPacket(`Probe b ${s}`, c.text("d")),
      "--body",
      c.decisionBody(s),
    ],
  ],
  [
    "decision-accept~b",
    (c, s) => [
      "decision",
      "accept",
      c.id("decision-propose~b", s),
      "--rationale",
      "b",
      "--judgment-only",
      "bench judgment",
    ],
  ],
  ["decision-supersede", (c, s) => ["decision", "supersede", c.id("decision-propose~b", s), "--reason", "bench"]],
  ["decision-retire", (c, s) => ["decision", "retire", c.id("decision-propose", s), "--reason", "bench"]],
  [
    "decision-repin",
    (c, s) => ["decision", "repin", c.decision(s), "--migration-evidence", `task/${c.task(s)}/task_plan.md`],
  ],
  // Relations.
  [
    "relation-relate",
    (c, s) => [
      ...["relation", "relate", "--source-ref", `task/${c.task(s + 3)}`, "--target-ref", `task/${c.task(s + 5)}`],
      ...["--type", "relates", "--rationale", c.text("rel"), "--expected-version", "0"],
    ],
  ],
  ["relation-list", () => ["relation", "list"]],
  ["relation-list~entity", (c, s) => ["relation", "list", "--entity", `task/${c.task(s + 3)}`]],
  [
    "relation-reconfirm",
    (c, s) => [
      ...["relation", "reconfirm", c.id("relation-relate", s), "--rationale", "bench"],
      ...["--expected-version", c.rev("relation-relate", s)],
    ],
  ],
  [
    "relation-unrelate",
    (c, s) => [
      ...["relation", "unrelate", c.id("relation-relate", s), "--reason", "bench"],
      ...["--expected-version", c.rev("relation-reconfirm", s)],
    ],
  ],
  // Generic entity store kinds, plus reads of the projected built-in kinds.
  ...entityEntries,
  ...["agent", "squad", "relation", "execution", "review", "schedule", "runtime-session", "settings"].map((kind) => [
    `entity-list~${kind}`,
    () => ["entity", "list", kind],
  ]),
  ["explain", () => ["explain", "task"]],
  ["explain~entity", (c, s) => ["explain", `task/${c.task(s)}`]],
  // Agents, squads, schedules, runtime instances (fixture user root only).
  ["agent-validate", (c, s) => ["agent", "validate", "--source", c.agentSource(s)]],
  ["agent-install", (c, s) => ["agent", "install", "--source", c.agentSource(s)]],
  ["agent-list", () => ["agent", "list"]],
  ["agent-inspect", (c, s) => ["agent", "inspect", `bench-agent-${s}`]],
  ["squad-validate", (c, s) => ["squad", "validate", "--source", c.squadSource(s)]],
  ["squad-install", (c, s) => ["squad", "install", "--source", c.squadSource(s)]],
  ["squad-list", () => ["squad", "list"]],
  ["squad-inspect", (c, s) => ["squad", "inspect", `bench-squad-${s}`]],
  [
    "runtime-instance-create",
    (c, s) => [
      ...["runtime", "instance", "create", "--id", `bench-rt-${s}`, "--name", `Bench ${s}`, "--kind", "codex"],
      ...["--provider", "openai", "--model", "bench-model", "--auth", "subscription"],
    ],
  ],
  ["runtime-instance-list", () => ["runtime", "instance", "list"]],
  ["runtime-instance-show", (c, s) => ["runtime", "instance", "show", `bench-rt-${s}`]],
  ["runtime-instance-update", (c, s) => ["runtime", "instance", "update", `bench-rt-${s}`, "--name", `B ${s}`]],
  ["runtime-status", () => ["runtime", "status"]],
  [
    "schedule-create",
    (c, s) => [
      ...["schedule", "create", `bench-sched-${s}`, "--name", `Sched ${s}`, "--mode", "detect", "--every", "24h"],
      ...["--agent", `bench-agent-${s}`, "--instance", `bench-rt-${s}`, "--mission", "bench", "--disabled"],
    ],
  ],
  ["schedule-list", () => ["schedule", "list"]],
  ["schedule-show", (c, s) => ["schedule", "show", `bench-sched-${s}`]],
  ["schedule-runs", (c, s) => ["schedule", "runs", `bench-sched-${s}`]],
  ["schedule-update", (c, s) => ["schedule", "update", `bench-sched-${s}`, "--name", `Sched ${s} v2`]],
  ["schedule-disable", (c, s) => ["schedule", "disable", `bench-sched-${s}`]],
  ["schedule-delete", (c, s) => ["schedule", "delete", `bench-sched-${s}`, "--reason", "bench"]],
  ["runtime-instance-delete", (c, s) => ["runtime", "instance", "delete", `bench-rt-${s}`]],
  [
    "agent-delete",
    (c, s) => ["agent", "delete", `bench-agent-${s}`, "--reason", "b", "--expected-version", c.rev("agent-install", s)],
  ],
  [
    "squad-delete",
    (c, s) => ["squad", "delete", `bench-squad-${s}`, "--reason", "b", "--expected-version", c.rev("squad-install", s)],
  ],
  // Settings, people, vertical, presets, templates, scripts.
  ["settings-read", () => ["settings", "read"]],
  ["settings-update", (c, s) => ["settings", "update", "--locale", s % 2 ? "zh-CN" : "en-US"]],
  [
    "people-add",
    (c, s) => [
      "people",
      "add",
      "--person-id",
      `bench-p-${s}`,
      "--display-name",
      `P ${s}`,
      "--role",
      "member",
      "--command-class",
      "repo-write",
    ],
  ],
  [
    "people-set-role",
    (c, s) => [
      "people",
      "set-role",
      "--person-id",
      `bench-p-${s}`,
      "--role",
      "reviewer",
      "--command-class",
      "repo-read",
    ],
  ],
  [
    "people-bind",
    (c, s) => [
      "people",
      "bind",
      "--actor",
      `person:bench-p-${s}`,
      "--role",
      "member",
      "--target",
      `person/bench-p-${s}`,
    ],
  ],
  ["people-remove", (c, s) => ["people", "remove", "--person-id", `bench-p-${s}`]],
  ["vertical-validate", () => ["vertical", "validate"]],
  ["vertical-kind-upsert-cli", (c, s) => ["vertical", "entity-kind", "upsert", "--from-file", c.kindFile(s)]],
  [
    "vertical-kind-publish-schema-cli",
    (c, s) => ["vertical", "entity-kind", "publish-schema", `bench-kind-${s}`, "--from-file", c.schemaFile(s)],
  ],
  ["vertical-kind-retire-cli", (c, s) => ["vertical", "entity-kind", "retire", `bench-kind-${s}`, "--reason", "bench"]],
  ["vertical-declaration-migrate", () => ["migrate", "vertical-declaration"]],
  ["preset-list", () => ["preset", "list"]],
  ["preset-inspect", () => ["preset", "inspect", "standard-task"]],
  ["preset-check", () => ["preset", "check", "standard-task"]],
  ["preset-audit", () => ["preset", "audit"]],
  ["preset-validate", (c) => ["preset", "validate", "--source", c.presetSource()]],
  ["preset-install", (c) => ["preset", "install", "--source", c.presetSource(), "--dry-run"]],
  ["preset-seed", () => ["preset", "seed", "--dry-run"]],
  ["preset-uninstall", () => ["preset", "uninstall", "docs-task", "--dry-run"]],
  ["preset-upgrade", (c, s) => ["preset", "upgrade", c.task(s + 40)]],
  ["template-list", () => ["template", "list"]],
  ["template-render", () => ["template", "render", "template://planning/task-plan@1"]],
  ["script-list", () => ["script", "list"]],
  ["script-inspect", (c) => ["script", "inspect", c.scriptId()]],
  // Ledger and daemon reads; receipts.
  ["receipt-show", (c, s) => ["receipt", "show", c.opId(s)]],
  ["ledger-reconcile", () => ["ledger", "reconcile", "--generation", "1"]],
  ["daemon-status", () => ["daemon", "status"]],
  ["doc-materialize", () => ["doc", "materialize"]],
  ["doc-retire", (c, s) => ["doc", "retire", "--path", `${c.packagePath(s)}/artifacts/bench-${s}.md`, "--reason", "b"]],
  // Client-local and offline commands (not daemon routes).
  ["capabilities", () => ["capabilities"]],
  ["version", () => ["--version"]],
  ["help", () => ["--help"]],
  ["events-tail", () => ["events", "tail"], offline],
  ["backup", (c, s) => ["backup", c.backupDir(s)], offline],
  ["restore-drill", (c, s) => ["restore", "--drill", c.backupDir(s)], offline],
  // Measured in the cold-read and rebuild phases, not here.
  ["daemon-stop", "measured in the cold-read phase (each cold sample is stop -> start -> first read)"],
  ["daemon-start", "measured in the cold-read phase"],
  ["daemon-projection-rebuild", "measured once in the rebuild-oracle phase (heavy full rebuild)"],
  ["repo-bootstrap", "measured once as `ha init` during fixture setup"],
  // Excluded, with the reason.
  ["gui", "launches the Electron GUI"],
  ["agent-create", runtime],
  ["squad-run", runtime],
  ["squad-status", "needs a squad run, which spawns runtimes"],
  ["squad-cancel", "needs a squad run, which spawns runtimes"],
  ["runtime-run", runtime],
  ["runtime-batch", runtime],
  ["runtime-cancel", "needs a live runtime session"],
  ["schedule-enable", "arms the schedule to dispatch a runtime"],
  ["schedule-run-now", runtime],
  ["script-run", "executes a vertical script process"],
  ["preset-run-start", "executes a preset script process"],
  ["runtime-instance-login", "interactive provider authentication"],
  ["runtime-instance-logout", "provider authentication state"],
  ["runtime-instance-github-credential-set", "writes a GitHub credential reference"],
  ["runtime-instance-github-credential-unset", "writes a GitHub credential reference"],
  ["people-delegate", "needs a live runtime session token"],
  ["people-revoke-delegation", "needs a live runtime session token"],
  ["ci-observe-pull", "network: shells out to gh against GitHub"],
  ["daemon-fleet-center-start", "network: opens a TLS fleet listener"],
  ["daemon-fleet-edge-sync", "network: syncs against a fleet center"],
  ["daemon-connection-add", "remote daemon connection topology"],
  ["daemon-connection-update", "remote daemon connection topology"],
  ["daemon-connection-remove", "remote daemon connection topology"],
  ["daemon-connection-probe", "network probe of a remote endpoint"],
  ["daemon-repo-register", "rewrites the daemon registry the fixture itself depends on"],
  ["daemon-repo-update", "rewrites the daemon registry the fixture itself depends on"],
  ["daemon-repo-unregister", "rewrites the daemon registry the fixture itself depends on"],
  ["doc-conflict-resolve", "needs a fleet edge/center content conflict"],
  ["doc-conflict-discard-local", "needs a fleet edge/center content conflict"],
  ["doc-conflict-overwrite-center", "needs a fleet edge/center content conflict"],
  ["migrate-import", "needs a legacy (pre-canonical) ledger source"],
  ["migrate-ledger", "needs a generation-1 backup; covered by generation-activation.integration.test.ts"],
];

// A metric id is `<registry command id>` or `<registry command id>~<variant>`.
export const registryId = (metric) => metric.split("~")[0];
