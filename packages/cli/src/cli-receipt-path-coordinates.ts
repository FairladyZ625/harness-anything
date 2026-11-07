/**
 * Output side of the CLI path coordinate: every caller-facing path is repository-relative.
 *
 * The daemon read model keeps the ledger's canonical `packagePath` and adds the workspace spelling
 * beside it (`workspacePackagePath`) so GUI consumers that need canonical keys are unaffected. This
 * boundary swaps the two on the CLI receipt and keeps the canonical value under `ledgerPackagePath`
 * for machine readers, matching the input rule: a path copied from a receipt pastes back into an
 * input flag from the same root.
 *
 * The swap is driven by the daemon-added field, not by a command list: a new receipt that carries the
 * workspace spelling gets the same translation without editing this file.
 */
type Receipt = Readonly<Record<string, unknown>>;

export function translateReceiptPathCoordinates(receipt: Receipt): Receipt {
  if (receipt.ok !== true) return receipt;
  const translated = translatePackagePath(receipt),
    evidence = translated.evidence;
  if (typeof evidence !== "string" || !evidence.startsWith("{") || !evidence.includes('"workspacePackagePath"'))
    return translated;
  let payload: unknown;
  try {
    payload = JSON.parse(evidence);
  } catch (error) {
    // A malformed evidence string is the daemon's own contract breach; fail closed rather than
    // printing a half-translated path.
    throw new Error("CLI receipt evidence is not valid JSON", { cause: error });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return translated;
  const record = payload as Record<string, unknown>,
    rows = Array.isArray(record.rows) ? record.rows : null,
    translatedPayload = rows
      ? {
          ...record,
          rows: rows.map((row) =>
            row !== null && typeof row === "object" && !Array.isArray(row)
              ? translatePackagePath(row as Record<string, unknown>)
              : row,
          ),
        }
      : translatePackagePath(record);
  return { ...translated, evidence: JSON.stringify(translatedPayload) };
}

function translatePackagePath(value: Record<string, unknown>): Record<string, unknown> {
  const workspace = value.workspacePackagePath;
  if (typeof workspace !== "string") return value;
  const { workspacePackagePath: _workspacePackagePath, ...rest } = value;
  return { ...rest, packagePath: workspace, ledgerPackagePath: value.packagePath };
}
