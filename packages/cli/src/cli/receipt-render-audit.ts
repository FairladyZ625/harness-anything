import { isRecord } from "./receipt-render-values.ts";

export function renderLedgerAuditExportReceipt(
  receipt: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): string | null {
  const manifest = isRecord(receipt.manifest)
    ? receipt.manifest
    : parsed && isRecord(parsed.manifest)
      ? parsed.manifest
      : null;
  if (!manifest) {
    if (parsed?.schema !== "audit-export-page/v1") return null;
    const nextCursor =
      isRecord(parsed.page) && typeof parsed.page.nextCursor === "string" ? parsed.page.nextCursor : null;
    return [
      `audit-export page: ${String(parsed.count ?? 0)} events (${String(parsed.algorithm)}, sourceRevision=${String(parsed.sourceRevision)})`,
      ...(nextCursor ? [`more: use --cursor ${nextCursor} or pass --output-dir <dir> to stream all pages`] : []),
    ].join("\n");
  }
  return [
    `audit-export: ok (${String(manifest.algorithm)}, ${String(manifest.eventCount)} events, rev ${String(manifest.firstRevision)}..${String(manifest.lastRevision)})`,
    `rootHash: ${String(manifest.rootHash)}`,
    `attribution: ${manifest.attributionStatus === "incomplete" ? "incomplete (strict attribution proof unavailable)" : "complete"}`,
    ...(typeof receipt.manifestPath === "string" ? [`manifest: ${receipt.manifestPath}`] : []),
    ...(typeof receipt.entriesPath === "string" ? [`entries: ${receipt.entriesPath}`] : []),
  ].join("\n");
}

export function renderLedgerAuditVerifyReceipt(receipt: Record<string, unknown>): string {
  if (receipt.ok !== true) {
    const coords = (
      [
        ["slice", receipt.sliceIndex, "number"],
        ["line", receipt.line, "number"],
        ["rev", receipt.workspaceRevision, "number"],
        ["opId", receipt.opId, "string"],
        ["field", receipt.field, "string"],
      ] as const
    ).flatMap(([k, v, t]) => (typeof v === t ? [`${k}=${String(v)}`] : []));
    const header =
      receipt.verificationStatus === "diagnostic_incomplete_attribution"
        ? `audit-verify: diagnostic_incomplete_attribution (chain_integrity=ok, attribution=failed, code=${String(receipt.code ?? "audit_person_attribution_missing")})`
        : `error code=${String(receipt.code ?? "audit_verify_failed")}`;
    const detail = coords.length
      ? `${coords.join(" ")} — ${String(receipt.message ?? "")}`
      : String(receipt.message ?? "");
    return [header, detail].filter(Boolean).join("\n");
  }
  const cert = isRecord(receipt.certificate) ? receipt.certificate : null;
  const anchor = isRecord(receipt.trustAnchor)
    ? String(receipt.trustAnchor.mode ?? "self-consistent-only")
    : "self-consistent-only";
  return [
    `audit-verify: ok (slices=${String(receipt.sliceCount ?? 0)}, events=${String(receipt.totalEvents ?? 0)}, trust=${anchor})`,
    ...(cert
      ? [
          `certificate: ${String(cert.taskId)} (${String(cert.completionKind ?? "native")}, ${String(cert.algorithm)}) ${String(cert.certificateHash)}`,
        ]
      : []),
  ].join("\n");
}

export function renderTaskDeliveryCertificateReceipt(
  receipt: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): string | null {
  const cert = isRecord(receipt.certificate)
    ? receipt.certificate
    : parsed && isRecord(parsed.certificate)
      ? parsed.certificate
      : parsed;
  if (!cert || cert.schema !== "delivery-certificate/v1") return null;
  return [
    `delivery-certificate: ${String(cert.taskId)} (${String(cert.completionKind ?? "native")}, ${String(cert.algorithm)}, status=${String(cert.status)})`,
    ...(typeof cert.submissionDigest === "string" ? [`submissionDigest: ${cert.submissionDigest}`] : []),
    ...(isRecord(cert.resolution)
      ? [`resolution: ${String(cert.resolution.kind)} (${String(cert.resolution.factRef)})`]
      : []),
    `certificateHash: ${String(cert.certificateHash)}`,
    ...(typeof receipt.outputPath === "string" ? [`output: ${receipt.outputPath}`] : []),
  ].join("\n");
}
