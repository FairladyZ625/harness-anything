import { isUtf8 } from "node:buffer";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import type {
  AuditCertificateChainCollector,
  AuditCertificateVerifyResult,
  AuditExportManifestV1,
  AuditExportWindowV1,
  AuditSliceVerifyDiagnostic,
  AuditSliceVerifySuccess,
  AuditVerifyFailure,
  DeliveryCertificateV1,
} from "@harness-anything/kernel/internal/integrity/audit-hash-chain.ts";
import type { AuditDigest, AuditHashAlgorithm, PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { cliErrorMessage } from "./cli-error.ts";
import { cliFailure } from "./cli-meta.ts";
import type { ThinCommand } from "./cli/thin-command-types.ts";

type AuditExportPagePayload = {
  readonly schema: "audit-export-page/v1";
  readonly repoId: string;
  readonly sourceRevision: number;
  readonly effectiveToRevision: number;
  readonly algorithm: AuditHashAlgorithm;
  readonly prevRootHash: AuditDigest;
  readonly window: AuditExportWindowV1;
  readonly events: readonly PersistedCanonicalEventV1[];
  readonly count: number;
  readonly scannedCount: number;
  readonly hasMore: boolean;
  readonly page: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly nextCursor: string | null;
  };
};

interface ParsedAuditVerifyArgs {
  readonly manifests: readonly string[];
  readonly entries: string | undefined;
  readonly certificate: string | undefined;
  readonly algorithm: AuditHashAlgorithm | undefined;
  readonly certificateAlgorithm: AuditHashAlgorithm | undefined;
  readonly prevRootHash: AuditDigest | undefined;
  readonly expectedRootHash: AuditDigest | undefined;
  readonly expectedCertificateHash: AuditDigest | undefined;
  readonly skipPersonCheck: boolean;
  readonly json: boolean;
}

export async function runLedgerAuditExport(
  command: ThinCommand,
  runDaemon: (requested: ThinCommand) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { outputDir: rawOutputDir, ...baseAction } = command.action;
  const outputDir = typeof rawOutputDir === "string" && rawOutputDir !== "" ? path.resolve(rawOutputDir) : undefined;
  // Without --output-dir, return one bounded RPC page (O(pageSize) memory); never accumulate all pages in RAM.
  if (outputDir === undefined) {
    return runDaemon({ ...command, action: baseAction as ThinCommand["action"] });
  }
  const kernel = await import("@harness-anything/kernel/internal/integrity/audit-hash-chain.ts");
  const hostIo = await import("@harness-anything/daemon/internal/host-environment-io");
  const entriesPath = path.join(outputDir, kernel.DEFAULT_AUDIT_ENTRIES_FILE);
  const manifestPath = path.join(outputDir, "audit-manifest.json");
  let lineWriter: Awaited<ReturnType<typeof hostIo.openCallerOutputLineWriter>> | null = null;
  let accumulator: ReturnType<typeof kernel.createAuditChainAccumulator> | null = null;
  let cursor: string | undefined = typeof baseAction.cursor === "string" ? baseAction.cursor : undefined;
  let pinnedToRevision: number | undefined =
    typeof baseAction.toRevision === "number" ? baseAction.toRevision : undefined;
  let pagesRead = 0;
  let sourceRevision = 0;
  let manifest: AuditExportManifestV1;
  let manifestWindow: AuditExportWindowV1 | null = null;
  let expectedPureRevision: number | null = null;
  let exportedEventCount = 0;
  let lastExportedRevision: number | null = null;
  try {
    for (;;) {
      const pageAction: ThinCommand["action"] = {
        ...baseAction,
        kind: "ledger-audit-export",
        ...(pinnedToRevision === undefined ? {} : { toRevision: pinnedToRevision }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const receipt = await runDaemon({ ...command, action: pageAction });
      if (receipt.ok !== true) {
        if (lineWriter !== null) await lineWriter.abort();
        return receipt;
      }
      const page = JSON.parse(String(receipt.evidence)) as AuditExportPagePayload;
      pagesRead += 1;
      if (accumulator === null) {
        sourceRevision = page.sourceRevision;
        pinnedToRevision = page.effectiveToRevision;
        manifestWindow = {
          ...page.window,
          toRevision: page.effectiveToRevision >= 1 ? page.effectiveToRevision : null,
        };
        if (kernel.isPureRevisionWindow(manifestWindow)) {
          const parsedCursor = cursor === undefined ? 0 : Number(cursor);
          expectedPureRevision = Math.max(
            manifestWindow.fromRevision ?? 1,
            Number.isInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor + 1 : 1,
          );
        }
        // Stage output only AFTER the first RPC page succeeds so auth/validation failures never touch outputDir.
        lineWriter = await hostIo.openCallerOutputLineWriter(entriesPath);
        accumulator = kernel.createAuditChainAccumulator({
          repoId: page.repoId,
          algorithm: page.algorithm,
          prevRootHash: page.prevRootHash,
          window: manifestWindow,
          entriesFile: kernel.DEFAULT_AUDIT_ENTRIES_FILE,
        });
      }
      for (const event of page.events) {
        if (expectedPureRevision !== null && event.workspaceRevision !== expectedPureRevision) {
          await lineWriter!.abort();
          return cliFailure(
            "ledger-audit-export",
            "audit_revision_gap",
            `Audit chain revision gap: expected contiguous workspaceRevision ${expectedPureRevision}, got ${event.workspaceRevision}.`,
          );
        }
        const { line } = accumulator.addEvent(event);
        await lineWriter!.writeLine(line);
        exportedEventCount += 1;
        lastExportedRevision = event.workspaceRevision;
        if (expectedPureRevision !== null) expectedPureRevision = event.workspaceRevision + 1;
      }
      if (!page.hasMore || page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    if (expectedPureRevision !== null && manifestWindow?.toRevision !== null && manifestWindow !== null) {
      const targetEnd = manifestWindow.toRevision;
      if (
        (exportedEventCount === 0 && expectedPureRevision <= targetEnd) ||
        (lastExportedRevision !== null && lastExportedRevision !== targetEnd)
      ) {
        await lineWriter!.abort();
        return cliFailure(
          "ledger-audit-export",
          "audit_revision_gap",
          `Audit chain revision gap: window ended at workspaceRevision ${lastExportedRevision ?? "none"}, expected ${targetEnd}.`,
        );
      }
    }
    manifest = accumulator!.finalize();
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    await lineWriter!.commit({ filePath: manifestPath, contents: manifestJson });
  } catch (error) {
    if (lineWriter !== null) await lineWriter.abort();
    throw error;
  } finally {
    if (lineWriter !== null) await lineWriter.close();
  }
  const warnings =
    manifest.attributionStatus === "incomplete"
      ? [
          `${manifest.personAttribution.unattributedEvents} canonical write event(s) lack actor.principal.personId; ` +
            "attribution proof is incomplete and strict audit-verify will reject this slice.",
        ]
      : undefined;
  return {
    ok: true,
    command: "ledger-audit-export",
    schema: "audit-export-receipt/v1",
    repoId: manifest.repoId,
    algorithm: manifest.algorithm,
    attributionStatus: manifest.attributionStatus,
    pagesRead,
    sourceRevision,
    manifest,
    outputDir,
    entriesPath,
    manifestPath,
    ...(warnings === undefined ? {} : { warnings }),
  };
}

export async function runTaskDeliveryCertificate(
  command: ThinCommand,
  runDaemon: (requested: ThinCommand) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { output: rawOutput, ...rpcAction } = command.action;
  const outputPath = typeof rawOutput === "string" && rawOutput !== "" ? path.resolve(rawOutput) : undefined;
  const receipt = await runDaemon({ ...command, action: rpcAction as ThinCommand["action"] });
  if (receipt.ok !== true) return receipt;
  const payload = JSON.parse(String(receipt.evidence)) as
    | { readonly schema?: string; readonly certificate?: DeliveryCertificateV1 }
    | DeliveryCertificateV1;
  const certificate =
    "certificate" in payload && payload.certificate !== undefined
      ? payload.certificate
      : (payload as DeliveryCertificateV1);
  if (outputPath !== undefined) {
    const hostIo = await import("@harness-anything/daemon/internal/host-environment-io");
    await hostIo.writeCallerOutputFile(outputPath, `${JSON.stringify(certificate, null, 2)}\n`);
  }
  return {
    ...receipt,
    certificate,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

export async function runLedgerAuditVerify(
  argv: readonly string[],
  emit: (receipt: Record<string, unknown>, json: boolean) => void,
): Promise<number> {
  const parsed = parseAuditVerifyArgs(argv);
  if (!parsed.ok) {
    emit(cliFailure("ledger-audit-verify", parsed.code, parsed.message), parsed.json);
    return 2;
  }
  const options = parsed.value;
  const kernel = await import("@harness-anything/kernel/internal/integrity/audit-hash-chain.ts");

  let certPath: string | undefined;
  let certValue: unknown;
  let certificateCollector: AuditCertificateChainCollector | undefined;
  if (options.certificate !== undefined) {
    certPath = path.resolve(options.certificate);
    const certJson = readJsonFile(certPath);
    if (!certJson.ok) {
      const failure = kernel.createAuditVerifyFailure(
        "audit_certificate_invalid",
        `Cannot read delivery certificate ${certPath}: ${certJson.error}`,
      );
      emit(auditVerifyErrorReceipt(failure, { certificatePath: certPath }), options.json);
      return 1;
    }
    certValue = certJson.value;
    if (options.manifests.length > 0) {
      const target = kernel.extractDeliveryCertificateChainTarget(certValue);
      if (target !== null) {
        certificateCollector = kernel.createAuditCertificateChainCollector(target);
      }
    }
  }

  const verifiedSlices: Array<
    (AuditSliceVerifySuccess | AuditSliceVerifyDiagnostic) & {
      readonly manifestPath: string;
      readonly entriesPath: string;
    }
  > = [];
  let expectedPrevRootHash: AuditDigest | undefined = options.prevRootHash;
  let totalEvents = 0;
  let diagnosticUnattributed:
    | (AuditSliceVerifyDiagnostic & {
        readonly sliceIndex: number;
        readonly manifestPath: string;
        readonly entriesPath: string;
      })
    | null = null;

  for (let index = 0; index < options.manifests.length; index += 1) {
    const manifestPath = path.resolve(options.manifests[index]!);
    const manifestResult = readJsonFile(manifestPath);
    if (!manifestResult.ok) {
      const failure = kernel.createAuditVerifyFailure(
        "audit_manifest_invalid",
        `Cannot read audit manifest ${manifestPath}: ${manifestResult.error}`,
      );
      emit(auditVerifyErrorReceipt(failure, { sliceIndex: index, manifestPath }), options.json);
      return 1;
    }
    const isLastSlice = index === options.manifests.length - 1;
    const created = kernel.createAuditSliceVerifier({
      manifest: manifestResult.value,
      ...(options.algorithm === undefined ? {} : { expectedAlgorithm: options.algorithm }),
      ...(expectedPrevRootHash === undefined ? {} : { expectedPrevRootHash }),
      ...(isLastSlice && options.expectedRootHash !== undefined ? { expectedRootHash: options.expectedRootHash } : {}),
      requirePersonAttribution: !options.skipPersonCheck,
      ...(certificateCollector === undefined ? {} : { certificateCollector }),
    });
    if (!created.ok) {
      emit(auditVerifyErrorReceipt(created, { sliceIndex: index, manifestPath }), options.json);
      return 1;
    }
    const manifestRecord = manifestResult.value as AuditExportManifestV1;
    const entriesPath =
      options.entries !== undefined
        ? path.resolve(options.entries)
        : path.resolve(path.dirname(manifestPath), manifestRecord.entriesFile);
    const streamResult = await verifyEntriesRawStream(entriesPath, created.verifier, kernel.createAuditVerifyFailure);
    if (!streamResult.ok) {
      const failurePayload = kernel.createAuditVerifyFailure(
        "audit_entries_unreadable",
        `Cannot read audit entries ${entriesPath}: ${streamResult.error}`,
      );
      emit(auditVerifyErrorReceipt(failurePayload, { sliceIndex: index, manifestPath, entriesPath }), options.json);
      return 1;
    }
    if (streamResult.failure !== null) {
      emit(
        auditVerifyErrorReceipt(streamResult.failure, { sliceIndex: index, manifestPath, entriesPath }),
        options.json,
      );
      return 1;
    }
    const finalized = created.verifier.finalize();
    if (!finalized.ok && finalized.diagnostic !== true) {
      emit(auditVerifyErrorReceipt(finalized, { sliceIndex: index, manifestPath, entriesPath }), options.json);
      return 1;
    }
    const previous = verifiedSlices.at(-1);
    if (previous !== undefined) {
      const seqError = kernel.verifyAuditSliceSequence(previous, finalized);
      if (seqError !== null) {
        emit(auditVerifyErrorReceipt(seqError, { sliceIndex: index, manifestPath, entriesPath }), options.json);
        return 1;
      }
    }
    verifiedSlices.push({ ...finalized, manifestPath, entriesPath });
    if (!finalized.ok && finalized.diagnostic === true && diagnosticUnattributed === null) {
      diagnosticUnattributed = { ...finalized, sliceIndex: index, manifestPath, entriesPath };
    }
    expectedPrevRootHash = finalized.rootHash;
    totalEvents += finalized.eventCount;
  }

  let certificateResult:
    | (Extract<AuditCertificateVerifyResult, { readonly ok: true }> & { readonly certificatePath: string })
    | undefined;
  if (certPath !== undefined) {
    const effectiveCertAlgorithm = options.certificateAlgorithm ?? options.algorithm;
    const verified = kernel.verifyDeliveryCertificate(certValue, {
      ...(effectiveCertAlgorithm === undefined ? {} : { expectedAlgorithm: effectiveCertAlgorithm }),
      ...(options.expectedCertificateHash === undefined
        ? {}
        : { expectedCertificateHash: options.expectedCertificateHash }),
      ...(options.manifests.length > 0 && certificateCollector !== undefined
        ? { chainEvidence: certificateCollector.evidence() }
        : {}),
    });
    if (!verified.ok) {
      emit(auditVerifyErrorReceipt(verified, { certificatePath: certPath }), options.json);
      return 1;
    }
    certificateResult = { ...verified, certificatePath: certPath };
  }

  const trustAnchor = {
    mode:
      options.expectedRootHash !== undefined || options.expectedCertificateHash !== undefined
        ? ("pinned" as const)
        : ("self-consistent-only" as const),
    ...(options.expectedRootHash === undefined ? {} : { expectedRootHash: options.expectedRootHash }),
    ...(options.expectedCertificateHash === undefined
      ? {}
      : { expectedCertificateHash: options.expectedCertificateHash }),
  };

  if (diagnosticUnattributed !== null) {
    emit(
      {
        ok: false,
        diagnostic: true,
        verificationStatus: "diagnostic_incomplete_attribution",
        strictVerified: false,
        chainIntegrityOk: true,
        attributionVerified: false,
        code: diagnosticUnattributed.code,
        message: diagnosticUnattributed.message,
        hint: diagnosticUnattributed.message,
        line: diagnosticUnattributed.line,
        workspaceRevision: diagnosticUnattributed.workspaceRevision,
        opId: diagnosticUnattributed.opId,
        field: diagnosticUnattributed.field,
        sliceIndex: diagnosticUnattributed.sliceIndex,
        manifestPath: diagnosticUnattributed.manifestPath,
        entriesPath: diagnosticUnattributed.entriesPath,
        command: "ledger-audit-verify",
        schema: "audit-verify-receipt/v1",
        trustAnchor,
        sliceCount: verifiedSlices.length,
        totalEvents,
        slices: verifiedSlices,
        ...(certificateResult === undefined ? {} : { certificate: certificateResult }),
      },
      options.json,
    );
    return 1;
  }

  emit(
    {
      ok: true,
      verificationStatus: "verified",
      strictVerified: true,
      command: "ledger-audit-verify",
      schema: "audit-verify-receipt/v1",
      trustAnchor,
      sliceCount: verifiedSlices.length,
      totalEvents,
      slices: verifiedSlices,
      ...(certificateResult === undefined ? {} : { certificate: certificateResult }),
    },
    options.json,
  );
  return 0;
}

function auditVerifyErrorReceipt(
  failure: AuditVerifyFailure,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...failure,
    hint: formatAuditVerifyErrorHint(failure),
    command: "ledger-audit-verify",
    schema: "audit-verify-receipt/v1",
    ...extra,
  };
}

function formatAuditVerifyErrorHint(failure: AuditVerifyFailure): string {
  const coords = [
    ...(failure.line === undefined ? [] : [`line=${failure.line}`]),
    ...(failure.workspaceRevision === undefined ? [] : [`rev=${failure.workspaceRevision}`]),
    ...(failure.opId === undefined ? [] : [`opId=${failure.opId}`]),
    ...(failure.field === undefined ? [] : [`field=${failure.field}`]),
  ];
  return coords.length > 0 ? `${coords.join(" ")}: ${failure.message}` : failure.message;
}

async function verifyEntriesRawStream(
  entriesPath: string,
  verifier: {
    readonly feedRawBytes: (chunk: Uint8Array) => void;
    readonly verifyLine: (rawLine: string, lineNumber: number) => AuditVerifyFailure | null;
  },
  createFailure: (
    errorCode: "audit_entry_parse_failed" | "audit_manifest_entries_digest_mismatch",
    message: string,
    detail?: { readonly line?: number; readonly field?: string },
  ) => AuditVerifyFailure,
): Promise<
  { readonly ok: true; readonly failure: AuditVerifyFailure | null } | { readonly ok: false; readonly error: string }
> {
  try {
    const stream = createReadStream(entriesPath);
    let pending = Buffer.alloc(0);
    let lineNumber = 0;
    try {
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        verifier.feedRawBytes(chunk);
        const combined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let start = 0;
        for (;;) {
          const lfIndex = combined.indexOf(0x0a, start);
          if (lfIndex === -1) break;
          lineNumber += 1;
          const lineBytes = combined.subarray(start, lfIndex);
          if (!isUtf8(lineBytes)) {
            stream.destroy();
            return {
              ok: true,
              failure: createFailure(
                "audit_entry_parse_failed",
                `Line ${lineNumber}: invalid UTF-8 byte sequence in audit entries stream.`,
                { line: lineNumber, field: "encoding" },
              ),
            };
          }
          const lineText = lineBytes.toString("utf8");
          const failure = verifier.verifyLine(lineText, lineNumber);
          if (failure !== null) {
            stream.destroy();
            return { ok: true, failure };
          }
          start = lfIndex + 1;
        }
        pending = start < combined.length ? Buffer.from(combined.subarray(start)) : Buffer.alloc(0);
      }
    } finally {
      stream.destroy();
    }
    if (pending.length > 0) {
      lineNumber += 1;
      return {
        ok: true,
        failure: createFailure(
          "audit_manifest_entries_digest_mismatch",
          `Line ${lineNumber}: audit entries file is missing its canonical trailing LF byte.`,
          { line: lineNumber, field: "entriesDigest" },
        ),
      };
    }
    return { ok: true, failure: null };
  } catch (error) {
    return { ok: false, error: cliErrorMessage(error) };
  }
}

function readJsonFile(
  filePath: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) as unknown };
  } catch (error) {
    return { ok: false, error: cliErrorMessage(error) };
  }
}

function parseAuditVerifyArgs(argv: readonly string[]):
  | { readonly ok: true; readonly value: ParsedAuditVerifyArgs }
  | {
      readonly ok: false;
      readonly code: "missing_field" | "invalid_field";
      readonly message: string;
      readonly json: boolean;
    } {
  const json = argv.includes("--json");
  const start = argv.indexOf("audit-verify");
  const rest = start < 0 ? [] : argv.slice(start + 1);
  const manifests: string[] = [];
  let entries: string | undefined;
  let certificate: string | undefined;
  let algorithm: AuditHashAlgorithm | undefined;
  let certificateAlgorithm: AuditHashAlgorithm | undefined;
  let prevRootHash: AuditDigest | undefined;
  let expectedRootHash: AuditDigest | undefined;
  let expectedCertificateHash: AuditDigest | undefined;
  let skipPersonCheck = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--json") continue;
    if (token === "--allow-unattributed") {
      skipPersonCheck = true;
      continue;
    }
    const next = rest[index + 1];
    if (token === "--manifest") {
      if (!next || next.startsWith("--"))
        return { ok: false, code: "missing_field", message: "--manifest requires a file path.", json };
      manifests.push(next);
      index += 1;
    } else if (token === "--entries") {
      if (!next || next.startsWith("--"))
        return { ok: false, code: "missing_field", message: "--entries requires a file path.", json };
      if (entries !== undefined)
        return { ok: false, code: "invalid_field", message: "Provide --entries only once.", json };
      entries = next;
      index += 1;
    } else if (token === "--certificate") {
      if (!next || next.startsWith("--"))
        return { ok: false, code: "missing_field", message: "--certificate requires a file path.", json };
      if (certificate !== undefined)
        return { ok: false, code: "invalid_field", message: "Provide --certificate only once.", json };
      certificate = next;
      index += 1;
    } else if (token === "--algorithm") {
      if (next !== "sha256" && next !== "sm3") {
        return { ok: false, code: "invalid_field", message: "--algorithm must be sha256 or sm3.", json };
      }
      algorithm = next;
      index += 1;
    } else if (token === "--certificate-algorithm") {
      if (next !== "sha256" && next !== "sm3") {
        return { ok: false, code: "invalid_field", message: "--certificate-algorithm must be sha256 or sm3.", json };
      }
      certificateAlgorithm = next;
      index += 1;
    } else if (token === "--prev-root-hash") {
      if (!next || !/^(?:sha256|sm3):[0-9a-f]{64}$/u.test(next)) {
        return { ok: false, code: "invalid_field", message: "--prev-root-hash must be <sha256|sm3>:<64-hex>.", json };
      }
      prevRootHash = next as AuditDigest;
      index += 1;
    } else if (token === "--expected-root-hash") {
      if (!next || !/^(?:sha256|sm3):[0-9a-f]{64}$/u.test(next)) {
        return {
          ok: false,
          code: "invalid_field",
          message: "--expected-root-hash must be <sha256|sm3>:<64-hex>.",
          json,
        };
      }
      expectedRootHash = next as AuditDigest;
      index += 1;
    } else if (token === "--expected-certificate-hash") {
      if (!next || !/^(?:sha256|sm3):[0-9a-f]{64}$/u.test(next)) {
        return {
          ok: false,
          code: "invalid_field",
          message: "--expected-certificate-hash must be <sha256|sm3>:<64-hex>.",
          json,
        };
      }
      expectedCertificateHash = next as AuditDigest;
      index += 1;
    } else {
      return {
        ok: false,
        code: "invalid_field",
        message: `Unsupported argument ${token}. Run ha ledger audit-verify --help.`,
        json,
      };
    }
  }
  if (manifests.length === 0 && certificate === undefined) {
    return {
      ok: false,
      code: "missing_field",
      message: "Specify at least one --manifest <path> or --certificate <path>. Run ha ledger audit-verify --help.",
      json,
    };
  }
  if (entries !== undefined && manifests.length !== 1) {
    return {
      ok: false,
      code: "invalid_field",
      message: "--entries can only be used together with a single --manifest.",
      json,
    };
  }
  if (expectedRootHash !== undefined && manifests.length === 0) {
    return {
      ok: false,
      code: "invalid_field",
      message: "--expected-root-hash requires at least one --manifest.",
      json,
    };
  }
  if ((expectedCertificateHash !== undefined || certificateAlgorithm !== undefined) && certificate === undefined) {
    return {
      ok: false,
      code: "invalid_field",
      message: "--expected-certificate-hash and --certificate-algorithm require --certificate.",
      json,
    };
  }
  return {
    ok: true,
    value: {
      manifests,
      entries,
      certificate,
      algorithm,
      certificateAlgorithm,
      prevRootHash,
      expectedRootHash,
      expectedCertificateHash,
      skipPersonCheck,
      json,
    },
  };
}
