import {
  taskPacketContractFor,
  taskPacketCrossFieldRuleDescriptions,
  taskPacketTemplateFor,
  type TaskPacketFieldSchema,
  type TaskPacketValueSchema
} from "./task-packet-contracts.ts";

export function renderTaskPacketHelp(commandKind: string): ReadonlyArray<string> {
  const contract = taskPacketContractFor(commandKind);
  const template = taskPacketTemplateFor(commandKind);
  if (!contract || !template) return [];
  return [
    "",
    `Packet template (copy as ${template.fileName}):`,
    ...JSON.stringify(template.value, null, 2).split("\n").map((line) => `  ${line}`),
    "",
    `Packet schema: ${contract.schemaId}`,
    "Field rules:",
    ...Object.entries(contract.fields).map(([name, field]) => renderFieldRule(name, field)),
    ...taskPacketCrossFieldRuleDescriptions(commandKind).map((rule) => `  - ${rule}`),
    ...renderLifecycleSequence(commandKind)
  ];
}

function renderFieldRule(name: string, field: TaskPacketFieldSchema): string {
  const requirement = field.required ? "required" : "optional";
  return `  - ${name} (${requirement}, ${valueShape(field)}): ${field.description}`;
}

function valueShape(schema: TaskPacketValueSchema): string {
  if (schema.values) return schema.values.join("|");
  if (schema.type === "array") return `array<${schema.items ? valueShape(schema.items) : "unknown"}>`;
  if (schema.type === "object") {
    const fields = Object.entries(schema.properties ?? {}).map(([name, child]) => `${name}: ${valueShape(child)}`);
    return `{ ${fields.join(", ")} }`;
  }
  return schema.type;
}

function renderLifecycleSequence(commandKind: string): ReadonlyArray<string> {
  if (commandKind === "task-submit") {
    return [
      "",
      "Required Holder order:",
      "  1. ha task start <task-id>",
      "     Acquires the active Holder V2 execution used by submit.",
      "  2. ha task submit <task-id> --from-file submission.json",
      "     Requires that active Holder and releases it after the submitted round is published.",
      "  3. ha task complete --help",
      "     Choose a mode-specific reconciliation sequence; completion requires the task to remain unheld."
    ];
  }
  if (commandKind === "task-complete") {
    return [
      "",
      "Required sequence for --approve --from-file (after task submit released the Holder):",
      "  1. git rev-parse HEAD",
      "     Put this full 40-character public workspace SHA in approval.commit.",
      "  2. ha task code-doc reconcile <task-id> --commit <approval.commit> --path <each-approval.paths-entry> [--pr <approval.prRef>]",
      "     Run before complete. Repeat --path in the same values as approval.paths; include --pr only when approval.prRef exists.",
      "  3. ha task complete <task-id> --approve --from-file approval.json",
      "     The task must be unheld; complete reads and verifies the pre-existing reconciliation.",
      "",
      "Required sequence for --commit-anchor:",
      "  1. git rev-parse HEAD",
      "     Use the returned full 40-character public workspace SHA as <anchor-commit>.",
      "  2. ha task code-doc reconcile <task-id> --commit <anchor-commit>",
      "     Run before complete with the same commit; do not add --path or --pr in this mode.",
      "  3. ha task complete <task-id> --commit-anchor <anchor-commit> --judgment <reason> --ci passed",
      "     Complete reads and verifies that commit-only reconciliation."
    ];
  }
  return [];
}
