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
  ["failure:hint", (args) => textArg(args, "hint")],
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
    "failure:unmet-criteria",
    (args) =>
      `Unmet criteria: ${(args.criteria as readonly { readonly ref: string; readonly explain: string }[])
        .map((entry) => `${entry.ref} — ${entry.explain}`)
        .join("; ")}`,
  ],
  [
    "failure:squad-leader",
    (args) => `Leader dispatch rejected: code=${textArg(args, "code")} hint=${textArg(args, "hint")}`,
  ],
]);

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
  const diagnostic = record(receipt.diagnostic) ? receipt.diagnostic : null,
    diagnosticHint = diagnostic ? renderDiagnostic(diagnostic) : null,
    baseHint =
      diagnosticHint ??
      renderTemplate("failure", "hint", {
        hint:
          typeof outer.hint === "string"
            ? outer.hint
            : typeof receipt.nextAction === "string"
              ? receipt.nextAction
              : typeof receipt.next === "string"
                ? receipt.next
                : "Command failed.",
      }),
    criteria = Array.isArray(receipt.unmetCriteria)
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

function renderTemplate(commandOrSchema: string, kind: string, args: GuidanceArgs): string {
  const template = guidanceTemplates.get(`${commandOrSchema}:${kind}`);
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

function stringListArg(args: GuidanceArgs, field: string): readonly string[] {
  const value = args[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0))
    throw new TypeError(`Guidance argument ${field} is missing.`);
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
