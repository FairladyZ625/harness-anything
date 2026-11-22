import { isRecord } from "./receipt-render-values.ts";

export function renderPresetListReceipt(receipt: Record<string, unknown>): string {
  const rows = JSON.parse(String(receipt.evidence)) as Array<Record<string, unknown>>;
  return rows
    .map((row) => {
      const gates = Array.isArray(row.completionGates) ? JSON.stringify(row.completionGates) : "unavailable",
        remediation =
          row.validity !== "valid" && typeof row.nextAction === "string" ? [`  remediation: ${row.nextAction}`] : [];
      return [
        `${String(row.id)} — ${String(row.title)} — ${String(row.description)}`,
        `  validity: ${String(row.validity)}`,
        `  defaultProfile: ${String(row.defaultProfile ?? "unavailable")}`,
        `  outputShape: ${String(row.outputShape ?? "unavailable")}`,
        `  completionGates: ${gates}`,
        ...remediation,
      ].join("\n");
    })
    .join("\n");
}

export function renderPresetAuditReceipt(
  _receipt: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload || payload.schema !== "preset-audit-report/v1") return null;
  const issues = Array.isArray(payload.issues) ? payload.issues.filter(isRecord) : [];
  return [
    `preset-audit: total=${String(payload.total ?? 0)} valid=${String(payload.valid ?? 0)} unavailable=${String(payload.unavailable ?? 0)} blocked=${String(payload.blocked ?? 0)}`,
    ...issues.flatMap((issue) => [
      `  [${String(issue.code ?? "issue")}] ${String(issue.presetId ?? "unknown")} (${String(issue.layer ?? "unknown")}): ${String(issue.message ?? "")}`,
      ...(typeof issue.remediation === "string" ? [`    remediation: ${issue.remediation}`] : []),
    ]),
  ].join("\n");
}

export function renderScaffoldReceipt(
  receipt: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload || (payload.schema !== "vertical-scaffold-report/v1" && payload.schema !== "preset-scaffold-report/v1"))
    return null;
  const created = Array.isArray(payload.created) ? payload.created.length : 0,
    overwritten = Array.isArray(payload.overwritten) ? payload.overwritten.length : 0;
  return [
    `${String(receipt.command ?? payload.schema)} (${String(payload.mode ?? "apply")}): ${String(payload.targetDir ?? "")}`,
    ...(typeof payload.verticalId === "string" ? [`  vertical: ${payload.verticalId}`] : []),
    ...(typeof payload.presetId === "string" ? [`  preset: ${payload.presetId}`] : []),
    ...(typeof payload.defaultPresetId === "string" ? [`  defaultPreset: ${payload.defaultPresetId}`] : []),
    ...(typeof payload.workPresetId === "string" ? [`  workPreset: ${payload.workPresetId}`] : []),
    `  files: created=${created} overwritten=${overwritten}`,
    ...(typeof payload.nextAction === "string" ? [`  next: ${payload.nextAction}`] : []),
  ].join("\n");
}

export function renderVerticalSimulateReceipt(
  _receipt: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload || payload.schema !== "vertical-simulate-report/v1") return null;
  const vertical = isRecord(payload.vertical) ? payload.vertical : {},
    bootstrap = isRecord(payload.bootstrap) ? payload.bootstrap : {},
    agents = isRecord(payload.agents) ? payload.agents : {},
    previews = isRecord(payload.previews) ? payload.previews : {},
    gates = Array.isArray(payload.gates) ? payload.gates.filter(isRecord) : [],
    diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics.filter(isRecord) : [],
    repoDocs = Array.isArray(previews.repository) ? previews.repository.length : 0,
    regDocs =
      isRecord(previews.regularTask) && Array.isArray(previews.regularTask.documents)
        ? previews.regularTask.documents.length
        : 0,
    workDocs =
      isRecord(previews.workTask) && Array.isArray(previews.workTask.documents)
        ? previews.workTask.documents.length
        : 0;
  return [
    `vertical-simulate: ${payload.ok === true ? "PASS" : "FAIL"} (${String(vertical.id ?? "unknown")}, zeroLedgerWrites=true)`,
    `  bootstrap: default=${String(bootstrap.defaultPresetId ?? "none")}/${String(bootstrap.defaultProfileId ?? "none")} work=${String(bootstrap.workPresetId ?? "none")}`,
    `  agents: ${Array.isArray(agents.ids) ? agents.ids.join(", ") || "none" : "none"}`,
    `  previews: repository=${repoDocs} regularTask=${regDocs} workTask=${workDocs}`,
    ...gates.map((gate) => {
      const pos = isRecord(gate.positive) ? String(gate.positive.result ?? "error") : "error",
        neg = isRecord(gate.negative) ? String(gate.negative.result ?? "error") : "error";
      return `  gate ${String(gate.gateId ?? "?")}: ${gate.ok === true ? "PASS" : "FAIL"} (positive=${pos}, negative=${neg})`;
    }),
    ...diagnostics.flatMap((item) => [
      `  [${String(item.severity ?? "info")}/${String(item.scope ?? "vertical")}] ${String(item.code ?? "")}: ${String(item.message ?? "")}`,
      ...(typeof item.remediation === "string" ? [`    remediation: ${item.remediation}`] : []),
    ]),
  ].join("\n");
}
