type GuidanceArgs = Readonly<Record<string, unknown>>;
type GuidanceTemplate = (args: GuidanceArgs) => string;

const guidanceTemplates = new Map<string, GuidanceTemplate>([
  [
    "task-create:repository-diff-contract",
    () =>
      "contract: repository-diff requires a committable public-repository diff, real CI, and a code-doc " +
      "reconciliation witness. For a task-package-only report or decision, use the task-package-artifact preset " +
      "docs-task.",
  ],
  ["task-create:task-create-publish", () => "next: remove --dry-run to publish this exact resolved scaffold"],
  [
    "task-create:task-create-start",
    (args) =>
      `next: edit ${textArg(args, "packagePath")}/task_plan.md, then run ha task start ${textArg(args, "taskId")} ` +
      "--execution-id <id>",
  ],
  ["task-create:receipt-query", (args) => `next: ha receipt show ${textArg(args, "opId")}`],
  [
    "task-create:edit-plan",
    (args) => `plan: write the concrete plan at harness/${textArg(args, "packagePath")}/task_plan.md`,
  ],
  [
    "task-create:pin-agenda",
    (args) => `agenda: use ha task pin ${textArg(args, "taskId")} to pin it to the CEO agenda`,
  ],
  [
    "task-create:ledger-managed",
    (args) =>
      `ledger: ${stringListArg(args, "fields").join(" and ")} are coordinator-managed; update them through ha doc sync`,
  ],
  [
    "failure:validation",
    (args) =>
      `Validation failed for entity=${textArg(args, "entity")} field=${textArg(args, "field")}; ` +
      `actual=${textArg(args, "actual")}; ${textArg(args, "expectation")}.`,
  ],
  [
    "failure:workspace-boundary",
    (args) =>
      `${textArg(args, "field")} must name a readable UTF-8 file inside workspace root ` +
      `${textArg(args, "workspaceRoot")}.`,
  ],
  ["failure:missing-sections", renderMissingSections],
  [
    "failure:materialization-failed",
    (args) =>
      `WAL-to-Git materialization failed: reason=${textArg(args, "reason")} ` +
      `lastCheckpointRevision=${numberArg(args, "lastCheckpointRevision")} ` +
      `lastCheckpointAt=${nullableTextArg(args, "lastCheckpointAt")} ` +
      `pendingWalEvents=${numberArg(args, "pendingWalEvents")} lastError=${textArg(args, "lastError")}. ` +
      "Repair the cause, then retry the write; the repository recovery path will " +
      "re-probe and resume without a daemon restart.",
  ],
  [
    "failure:materialization-retrying",
    (args) =>
      `WAL-to-Git materialization is retrying: waited=${numberArg(args, "retryElapsedMs")}ms ` +
      `lastCheckpointRevision=${numberArg(args, "lastCheckpointRevision")} ` +
      `lastCheckpointAt=${nullableTextArg(args, "lastCheckpointAt")} ` +
      `pendingWalEvents=${numberArg(args, "pendingWalEvents")} lastError=${textArg(args, "lastError")}. ` +
      "New writes are temporarily refused while the durable WAL retries; wait and retry the write " +
      "without restarting the daemon.",
  ],
  [
    "failure:invalid-enum",
    (args) =>
      `${textArg(args, "field")} must be one of ${stringListArg(args, "allowedValues").join(", ")}; ` +
      `received ${textArg(args, "actual")}.`,
  ],
  ["failure:failure", (args) => `Inspect error code ${textArg(args, "code")}, correct the command input, and retry.`],
  [
    "failure:unmet-criteria",
    (args) =>
      `Unmet criteria: ${(args.criteria as readonly { readonly ref: string; readonly explain: string }[])
        .map((entry) => `${entry.ref} — ${entry.explain}`)
        .join("; ")}`,
  ],
  ["*:retry-receipt", (args) => `next: ha receipt show ${textArg(args, "opId")}`],
  ["*:run-command", (args) => `next: ${textArg(args, "command")}`],
  ["*:remove-dry-run", (args) => `next: remove --dry-run and rerun ${textArg(args, "command")}`],
  ["*:no-action", () => "next: no action required"],
  [
    "failure:daemon-stopping",
    () =>
      "The daemon is draining its write queues before it exits and admits no new work; it releases its " +
      "endpoint, pid file and singleton lock together when the drain finishes. Run ha daemon status to see " +
      "what is still draining, then retry — the next command starts the replacement daemon.",
  ],
  [
    "failure:squad-leader",
    (args) => `Leader dispatch rejected: code=${textArg(args, "code")} hint=${textArg(args, "hint")}`,
  ],
  ["cli:flag-value", (args) => `${textArg(args, "name")} is a flag and takes no value.`],
  ["cli:duplicate-input", (args) => `${textArg(args, "name")} may appear once.`],
  ["cli:unknown-input", (args) => `Unknown option ${textArg(args, "name")}. Run ${textArg(args, "helpCommand")}.`],
  ["cli:missing-input", renderMissingInput],
  ["cli:invalid-input", renderInvalidInput],
  ["cli:run-help", (args) => `Run ${textArg(args, "helpCommand")}.`],
  ["cli:direct-daemon-failure", (args) => textArg(args, "message")],
  ["cli:daemon-connection-failure", (args) => `Local daemon request failed. Cause: ${textArg(args, "message")}`],
  ["cli:daemon-build-stale", () => "Restart the local daemon so its build matches this CLI, then retry the command."],
  [
    "cli:daemon-target-conflict",
    (args) =>
      `Daemon target conflict: injected target endpoint=${JSON.stringify(textArg(args, "endpoint"))} ` +
      `userRoot=${JSON.stringify(textArg(args, "userRoot"))} daemonId=${JSON.stringify(textArg(args, "daemonId"))} ` +
      `repoId=${JSON.stringify(args.repoId ?? null)} canonicalRoot=${JSON.stringify(args.canonicalRoot ?? null)}; ` +
      `resolved registry target endpoint=${JSON.stringify(textArg(args, "expected"))} ` +
      `userRoot=${JSON.stringify(textArg(args, "userRoot"))} daemonId=${JSON.stringify(textArg(args, "daemonId"))} ` +
      `repoId=${JSON.stringify(args.repoId ?? null)} canonicalRoot=${JSON.stringify(args.canonicalRoot ?? null)}. ` +
      "Unset HARNESS_DAEMON_ENDPOINT to use the resolved registry target, or restore the original " +
      "HARNESS_DAEMON_USER_ROOT and HARNESS_DAEMON_ID before retrying.",
  ],
  [
    "cli:explain-usage",
    () =>
      "Use ha explain task|person|squad|<artifact-type@version> for a catalog, or ha explain <entity-ref>... " +
      "for objects.",
  ],
  ["cli:task-explain-overlay", () => "Use ha task --help --explain task/<task-id> with exactly one Task ref."],
  [
    "cli:explain-subject-remedy",
    (args) => `Use a valid EntityRef in place of ${textArg(args, "ref")}, then rerun ha explain.`,
  ],
  [
    "cli:explain-action-remedy",
    (args) => `Resolve the listed criteria or authorization decision, then retry ${textArg(args, "usage")}.`,
  ],
  [
    "cli:unsupported-command",
    (args) => {
      const domain = optionalTextArg(args, "domain"),
        verb = optionalTextArg(args, "verb"),
        domains = stringListArg(args, "domains");
      if (!domain) return `No command domain was named; use one of ${domains.join(", ")}.`;
      if (!domains.includes(domain)) return `${domain} is not a command domain; use one of ${domains.join(", ")}.`;
      return verb
        ? `${domain} has no ${verb} command; run ha ${domain} --help for the commands it does have.`
        : `ha ${domain} needs a command; run ha ${domain} --help for the commands it has.`;
    },
  ],
]);

export function renderCliGuidance(kind: string, args: GuidanceArgs): string {
  return renderTemplate("cli", kind, args);
}

export function renderReceiptGuidance(receipt: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(receipt.guidance)) return [];
  const commandOrSchema = typeof receipt.command === "string" ? receipt.command : String(receipt.schema ?? "receipt");
  return receipt.guidance.flatMap((value) => {
    if (!record(value) || typeof value.kind !== "string" || !record(value.args) || !matchesWhen(receipt, value.when))
      return [];
    return [renderTemplate(commandOrSchema, value.kind, value.args)];
  });
}

export function humanError(receipt: Record<string, unknown>): { readonly code: string; readonly hint: string } {
  const outer = record(receipt.error) ? receipt.error : {},
    code = typeof outer.code === "string" ? outer.code : typeof receipt.code === "string" ? receipt.code : "unknown",
    leader = record(receipt.leader) ? humanError(receipt.leader) : null;
  if (code === "squad_leader_failed" && leader && leader.code !== "unknown")
    return { code, hint: renderTemplate("failure", "squad-leader", leader) };
  if (code === "daemon_stopping") return { code, hint: renderTemplate("failure", "daemon-stopping", {}) };
  if (code === "daemon_restarting" && typeof outer.hint === "string") return { code, hint: outer.hint };
  const diagnostic = record(receipt.diagnostic) ? receipt.diagnostic : null,
    diagnosticHint = diagnostic ? renderDiagnostic(diagnostic) : null,
    declaredGuidance = renderReceiptGuidance(receipt),
    baseHint =
      diagnosticHint ??
      (declaredGuidance.length > 0 ? declaredGuidance.join(" ") : null) ??
      renderTemplate("failure", "failure", { code }),
    criteria = diagnosticHint
      ? []
      : Array.isArray(receipt.unmetCriteria)
        ? receipt.unmetCriteria.flatMap((entry) =>
            record(entry) && typeof entry.ref === "string" && typeof entry.explain === "string"
              ? [{ ref: entry.ref, explain: entry.explain }]
              : [],
          )
        : [],
    hint =
      criteria.length === 0 ? baseHint : `${baseHint} ${renderTemplate("failure", "unmet-criteria", { criteria })}`;
  return { code, hint };
}

function renderDiagnostic(diagnostic: Record<string, unknown>): string | null {
  if (diagnostic.kind === "validation") return renderTemplate("failure", "validation", diagnostic);
  if (diagnostic.kind === "workspace-boundary") return renderTemplate("failure", "workspace-boundary", diagnostic);
  if (diagnostic.kind === "missing-sections") return renderTemplate("failure", "missing-sections", diagnostic);
  if (diagnostic.kind === "materialization-failed")
    return renderTemplate("failure", "materialization-failed", diagnostic);
  if (diagnostic.kind === "materialization-retrying")
    return renderTemplate("failure", "materialization-retrying", diagnostic);
  if (diagnostic.kind === "invalid-enum") return renderTemplate("failure", "invalid-enum", diagnostic);
  if (diagnostic.kind === "failure") return renderTemplate("failure", "failure", diagnostic);
  return null;
}

function renderMissingSections(args: GuidanceArgs): string {
  const path = textArg(args, "documentPath"),
    rows = Array.isArray(args.missingSections)
      ? args.missingSections.flatMap((entry) =>
          record(entry) &&
          typeof entry.section === "string" &&
          (entry.reason === "empty" || entry.reason === "scaffold")
            ? [
                entry.reason === "empty"
                  ? `- ${entry.section}: empty`
                  : `- ${entry.section}: still contains scaffold text “${String(entry.retainedScaffold ?? "")}”`,
              ]
            : [],
        )
      : [],
    sync = `ha doc sync --submit --path ${path}`;
  return [
    "Required-section diagnostics:",
    ...(rows.length ? rows : ["- no missing required sections were reported"]),
    args.diskDiffers === true
      ? `The on-disk harness/${path} differs; complete it, then run ${sync} and retry.`
      : `Edit harness/${path}, then run ${sync} and retry.`,
  ].join("\n");
}

function renderMissingInput(args: GuidanceArgs): string {
  return `${textArg(args, "name")} is required. Run ${textArg(args, "helpCommand")} for accepted inputs.`;
}

function renderInvalidInput(args: GuidanceArgs): string {
  const name = textArg(args, "name"),
    values = Array.isArray(args.values) ? stringListArg(args, "values") : [],
    format = optionalTextArg(args, "format"),
    pattern = optionalTextArg(args, "pattern"),
    helpCommand = textArg(args, "helpCommand");
  if (args.code === "invalid_runtime_effort")
    return "Use minimal, low, medium, high, xhigh, or max with Claude or Codex; agy supports low, medium, or high.";
  if (values.length > 0) return `Use ${name} with one of ${values.join(", ")}.`;
  if (format) return `Use ${name} with format ${format}.`;
  if (pattern) return `Use ${name} with a value matching /${pattern}/u.`;
  return `Use one non-empty value for ${name}. Run ${helpCommand} for accepted inputs.`;
}

function renderTemplate(commandOrSchema: string, kind: string, args: GuidanceArgs): string {
  const template = guidanceTemplates.get(`${commandOrSchema}:${kind}`) ?? guidanceTemplates.get(`*:${kind}`);
  if (!template) throw new TypeError(`No CLI guidance template is registered for ${commandOrSchema}:${kind}.`);
  return template(args);
}

function matchesWhen(receipt: Record<string, unknown>, value: unknown): boolean {
  return !record(value) || Object.entries(value).every(([field, expected]) => valueAtPath(receipt, field) === expected);
}

function valueAtPath(value: Record<string, unknown>, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>((current, segment) => (record(current) ? current[segment] : undefined), value);
}

function textArg(args: GuidanceArgs, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`Guidance argument ${field} is missing.`);
  return value;
}

function optionalTextArg(args: GuidanceArgs, field: string): string | null {
  const value = args[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringListArg(args: GuidanceArgs, field: string): readonly string[] {
  const value = args[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0))
    throw new TypeError(`Guidance argument ${field} is missing.`);
  return value;
}

function numberArg(args: GuidanceArgs, field: string): number {
  const value = args[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`Guidance argument ${field} is missing.`);
  return value;
}

function nullableTextArg(args: GuidanceArgs, field: string): string {
  const value = args[field];
  if (value === null) return "none";
  return textArg(args, field);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
