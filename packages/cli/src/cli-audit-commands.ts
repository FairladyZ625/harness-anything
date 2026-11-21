import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  AuditCertificateVerifyResult,
  AuditExportEntryV1,
  AuditExportManifestV1,
  AuditExportWindowV1,
  AuditSliceVerifyResult,
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
  readonly prevRootHash: AuditDigest | undefined;
  readonly skipPersonCheck: boolean;
  readonly json: boolean;
}

export async function runLedgerAuditExport(
  command: ThinCommand,
  runDaemon: (requested: ThinCommand) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { outputDir: rawOutputDir, ...baseAction } = command.action;
  const outputDir = typeof rawOutputDir === "string" && rawOutputDir !== "" ? path.resolve(rawOutputDir) : undefined;
  if (outputDir === undefined && baseAction.cursor !== undefined) {
    return runDaemon({ ...command, action: baseAction as ThinCommand["action"] });
  }
  const kernel = await import("@harness-anything/kernel/internal/integrity/audit-hash-chain.ts");
  const hostIo = outputDir === undefined ? null : await import("@harness-anything/daemon/internal/host-environment-io");
  const entriesPath = outputDir === undefined ? undefined : path.join(outputDir, kernel.DEFAULT_AUDIT_ENTRIES_FILE);
  const manifestPath = outputDir === undefined ? undefined : path.join(outputDir, "audit-manifest.json");
  const lineWriter =
    hostIo !== null && entriesPath !== undefined ? await hostIo.openCallerOutputLineWriter(entriesPath) : null;
  const collectedEntries: AuditExportEntryV1[] = [];
  let accumulator: ReturnType<typeof kernel.createAuditChainAccumulator> | null = null;
  let cursor: string | undefined = typeof baseAction.cursor === "string" ? baseAction.cursor : undefined;
  let pinnedToRevision: number | undefined =
    typeof baseAction.toRevision === "number" ? baseAction.toRevision : undefined;
  let pagesRead = 0;
  let sourceRevision = 0;
  try {
    for (;;) {
      const pageAction: ThinCommand["action"] = {
        ...baseAction,
        kind: "ledger-audit-export",
        ...(pinnedToRevision === undefined ? {} : { toRevision: pinnedToRevision }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const receipt = await runDaemon({ ...command, action: pageAction });
      if (receipt.ok !== true) return receipt;
      const page = JSON.parse(String(receipt.evidence)) as AuditExportPagePayload;
      pagesRead += 1;
      if (accumulator === null) {
        sourceRevision = page.sourceRevision;
        pinnedToRevision = page.effectiveToRevision;
        accumulator = kernel.createAuditChainAccumulator({
          repoId: page.repoId,
          algorithm: page.algorithm,
          prevRootHash: page.prevRootHash,
          window: {
            ...page.window,
            toRevision: page.effectiveToRevision,
          },
          entriesFile: kernel.DEFAULT_AUDIT_ENTRIES_FILE,
        });
      }
      for (const event of page.events) {
        const { entry, line } = accumulator.addEvent(event);
        if (lineWriter !== null) await lineWriter.writeLine(line);
        else collectedEntries.push(entry);
      }
      if (!page.hasMore || page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
  } finally {
    if (lineWriter !== null) await lineWriter.close();
  }
  const manifest = accumulator!.finalize();
  if (hostIo !== null && manifestPath !== undefined) {
    await hostIo.writeCallerOutputFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {
    ok: true,
    command: "ledger-audit-export",
    schema: "audit-export-receipt/v1",
    repoId: manifest.repoId,
    algorithm: manifest.algorithm,
    pagesRead,
    sourceRevision,
    manifest,
    ...(outputDir !== undefined ? { outputDir, entriesPath, manifestPath } : { entries: collectedEntries }),
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
  const verifiedSlices: Array<
    Extract<AuditSliceVerifyResult, { readonly ok: true }> & {
      readonly manifestPath: string;
      readonly entriesPath: string;
    }
  > = [];
  const allObservedEvents = new Map<
    string,
    { readonly workspaceRevision: number; readonly eventDigest: AuditDigest }
  >();
  let expectedPrevRootHash: AuditDigest | undefined = options.prevRootHash;
  let totalEvents = 0;

  for (let index = 0; index < options.manifests.length; index += 1) {
    const manifestPath = path.resolve(options.manifests[index]!);
    const manifestResult = readJsonFile(manifestPath);
    if (!manifestResult.ok) {
      const failure = kernel.createAuditVerifyFailure(
        "audit_manifest_invalid",
        `Cannot read audit manifest ${manifestPath}: ${manifestResult.error}`,
      );
      emit(
        {
          ...failure,
          command: "ledger-audit-verify",
          schema: "audit-verify-receipt/v1",
          sliceIndex: index,
          manifestPath,
        },
        options.json,
      );
      return 1;
    }
    const created = kernel.createAuditSliceVerifier({
      manifest: manifestResult.value,
      ...(options.algorithm === undefined ? {} : { expectedAlgorithm: options.algorithm }),
      ...(expectedPrevRootHash === undefined ? {} : { expectedPrevRootHash }),
      requirePersonAttribution: !options.skipPersonCheck,
    });
    if (!created.ok) {
      emit(
        {
          ...created,
          command: "ledger-audit-verify",
          schema: "audit-verify-receipt/v1",
          sliceIndex: index,
          manifestPath,
        },
        options.json,
      );
      return 1;
    }
    const manifestRecord = manifestResult.value as AuditExportManifestV1;
    const entriesPath =
      options.entries !== undefined
        ? path.resolve(options.entries)
        : path.resolve(path.dirname(manifestPath), manifestRecord.entriesFile);
    const streamResult = await verifyEntriesStream(entriesPath, created.verifier);
    if (!streamResult.ok || streamResult.failure !== null) {
      const failurePayload = streamResult.ok
        ? streamResult.failure
        : kernel.createAuditVerifyFailure(
            "audit_entries_unreadable",
            `Cannot read audit entries ${entriesPath}: ${streamResult.error}`,
          );
      emit(
        {
          ...failurePayload,
          command: "ledger-audit-verify",
          schema: "audit-verify-receipt/v1",
          sliceIndex: index,
          manifestPath,
          entriesPath,
        },
        options.json,
      );
      return 1;
    }
    const finalized = created.verifier.finalize();
    if (!finalized.ok) {
      emit(
        {
          ...finalized,
          command: "ledger-audit-verify",
          schema: "audit-verify-receipt/v1",
          sliceIndex: index,
          manifestPath,
          entriesPath,
        },
        options.json,
      );
      return 1;
    }
    verifiedSlices.push({ ...finalized, manifestPath, entriesPath });
    expectedPrevRootHash = finalized.rootHash;
    totalEvents += finalized.eventCount;
    if (options.certificate !== undefined) {
      for (const [opId, info] of created.verifier.observedEvents) allObservedEvents.set(opId, info);
    }
  }

  let certificateResult:
    | (Extract<AuditCertificateVerifyResult, { readonly ok: true }> & { readonly certificatePath: string })
    | undefined;
  if (options.certificate !== undefined) {
    const certificatePath = path.resolve(options.certificate);
    const certJson = readJsonFile(certificatePath);
    if (!certJson.ok) {
      const failure = kernel.createAuditVerifyFailure(
        "audit_certificate_invalid",
        `Cannot read delivery certificate ${certificatePath}: ${certJson.error}`,
      );
      emit(
        { ...failure, command: "ledger-audit-verify", schema: "audit-verify-receipt/v1", certificatePath },
        options.json,
      );
      return 1;
    }
    const verified = kernel.verifyDeliveryCertificate(certJson.value, {
      ...(options.algorithm === undefined ? {} : { expectedAlgorithm: options.algorithm }),
      ...(options.manifests.length > 0 ? { verifiedEvents: allObservedEvents } : {}),
    });
    if (!verified.ok) {
      emit(
        { ...verified, command: "ledger-audit-verify", schema: "audit-verify-receipt/v1", certificatePath },
        options.json,
      );
      return 1;
    }
    certificateResult = { ...verified, certificatePath };
  }

  emit(
    {
      ok: true,
      command: "ledger-audit-verify",
      schema: "audit-verify-receipt/v1",
      sliceCount: verifiedSlices.length,
      totalEvents,
      slices: verifiedSlices,
      ...(certificateResult === undefined ? {} : { certificate: certificateResult }),
    },
    options.json,
  );
  return 0;
}

async function verifyEntriesStream(
  entriesPath: string,
  verifier: { readonly verifyLine: (rawLine: string, lineNumber: number) => AuditVerifyFailure | null },
): Promise<
  { readonly ok: true; readonly failure: AuditVerifyFailure | null } | { readonly ok: false; readonly error: string }
> {
  try {
    const stream = createReadStream(entriesPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of rl) {
        lineNumber += 1;
        const failure = verifier.verifyLine(line, lineNumber);
        if (failure !== null) {
          rl.close();
          stream.destroy();
          return { ok: true, failure };
        }
      }
    } finally {
      rl.close();
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
  let prevRootHash: AuditDigest | undefined;
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
    } else if (token === "--prev-root-hash") {
      if (!next || !/^(?:sha256|sm3):[0-9a-f]{64}$/u.test(next)) {
        return { ok: false, code: "invalid_field", message: "--prev-root-hash must be <sha256|sm3>:<64-hex>.", json };
      }
      prevRootHash = next as AuditDigest;
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
  return {
    ok: true,
    value: { manifests, entries, certificate, algorithm, prevRootHash, skipPersonCheck, json },
  };
}
