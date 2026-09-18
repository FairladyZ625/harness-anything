import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assessTransitionDocument,
  assertTransitionDocumentReady,
  consumeKnownError,
  normalizeRelativeDocumentPath,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  sha256Text,
  transitionDocumentContract,
  type MarkdownDocumentContract,
  type TaskProjection,
  type TaskProjectionQueries,
  type TransitionDocumentMissingSection,
} from "../../kernel/src/index.ts";
import { loadCanonicalAssets } from "../../preset/src/preset-assets.ts";
import { requiredRegularFile, safeTemplatePath } from "../../preset/src/preset-materialization.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import type { CatalogSource } from "../../preset/src/preset-resolver-types.ts";

export type TaskTransitionDocumentSlot = "task.plan" | "task.closeout";

export interface TaskTransitionDocument {
  readonly packagePath: string;
  readonly path: string;
  readonly body: string;
  readonly blobSha256: string;
  readonly workspaceRevision: number;
  readonly source: "canonical projection" | "submitted candidate";
  /** The scaffold-derived readiness contract for this document, when resolvable. */
  readonly contract: MarkdownDocumentContract | null;
}

export type TransitionDocumentBlobReader = (sha256: string) => Uint8Array | null;

interface TransitionDocumentDescriptor {
  readonly slot: string;
  readonly path: string;
  readonly templateRef?: unknown;
  readonly locale?: unknown;
  readonly contentSha256?: unknown;
  readonly bodyDigest?: unknown;
}

/**
 * Resolves the readiness contract a task package's scaffold declared: the materialized scaffold
 * blob the descriptor's recorded sha addresses first, then — for mirrored packages without blob
 * access (fleet edge) — the bundled template catalog the descriptor's `templateRef` names.
 * Returns null when no source yields the scaffold.
 */
export function transitionDocumentReadinessContract(input: {
  readonly contract: unknown;
  readonly descriptor: TransitionDocumentDescriptor;
  readonly readBlob?: TransitionDocumentBlobReader;
}): MarkdownDocumentContract | null {
  const sha = scaffoldSha256(input.descriptor);
  if (sha && input.readBlob) {
    const bytes = input.readBlob(sha);
    if (bytes) return transitionDocumentContract(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  const catalogBody = catalogScaffoldBody(input.contract, input.descriptor);
  return catalogBody === null ? null : transitionDocumentContract(catalogBody);
}

function scaffoldSha256(descriptor: TransitionDocumentDescriptor): string | null {
  if (typeof descriptor.contentSha256 === "string" && /^[0-9a-f]{64}$/u.test(descriptor.contentSha256))
    return descriptor.contentSha256;
  if (typeof descriptor.bodyDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(descriptor.bodyDigest))
    return descriptor.bodyDigest.slice("sha256:".length);
  return null;
}

function catalogScaffoldBody(contract: unknown, descriptor: TransitionDocumentDescriptor): string | null {
  const templateRef = descriptor.templateRef;
  if (typeof templateRef !== "string" || !templateRef) return null;
  const locale =
      typeof descriptor.locale === "string" && descriptor.locale
        ? descriptor.locale
        : contract && typeof contract === "object" && !Array.isArray(contract)
          ? (contract as { readonly locale?: unknown }).locale
          : undefined,
    assets = loadCatalogAssets();
  if (assets === null || typeof locale !== "string") return null;
  const document = assets.catalog.documents.find((item) => `template://${item.id}@${item.version}` === templateRef),
    variant = document?.locales.find((item) => item.locale === locale) ?? document?.locales[0];
  if (!variant) return null;
  try {
    return requiredRegularFile(safeTemplatePath(assets.root, variant.bodyPath, templateRef), "missing_template");
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

let bundledCatalog: CatalogSource | null | undefined;

function loadCatalogAssets(): CatalogSource | null {
  if (bundledCatalog === undefined) {
    try {
      bundledCatalog = loadCanonicalAssets(defaultAssets).catalog;
    } catch (error) {
      consumeKnownError(error);
      bundledCatalog = null;
    }
  }
  return bundledCatalog;
}

export function readTaskTransitionDocument(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
  readonly readBlob?: TransitionDocumentBlobReader;
}): TaskTransitionDocument {
  const task = input.projection.read(input.taskId);
  if (task.watermark < task.sourceRevision || !task.snapshot.task || !task.packagePath)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} package projection is not ready for ${input.slot}.`,
    );
  const contractPath = `${task.packagePath}/task-contract.json`,
    contractRead = input.projection.readDocument(contractPath);
  if (contractRead.watermark < contractRead.sourceRevision || !contractRead.document)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} contract projection is not ready for ${input.slot}.`,
    );
  let contract: unknown;
  try {
    contract = JSON.parse(contractRead.document.body);
  } catch {
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} contract document is invalid.`);
  }
  const row = contract && typeof contract === "object" && !Array.isArray(contract) ? contract : null,
    documents =
      row && Array.isArray((row as { readonly documents?: unknown }).documents)
        ? (row as { readonly documents: readonly unknown[] }).documents
        : [],
    descriptor = documents.find(
      (value): value is TransitionDocumentDescriptor & { readonly slot: string; readonly path: string } =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { readonly slot?: unknown }).slot === input.slot &&
        typeof (value as { readonly path?: unknown }).path === "string",
    );
  if (!descriptor)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} contract has no ${input.slot} document.`,
    );
  let documentPath: string;
  try {
    documentPath = normalizeRelativeDocumentPath(`${task.packagePath}/${descriptor.path}`);
  } catch {
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} path is invalid.`);
  }
  if (!documentPath.startsWith(`${task.packagePath}/`))
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} leaves its package.`);
  const documentRead = input.projection.readDocument(documentPath);
  if (documentRead.watermark < documentRead.sourceRevision || !documentRead.document)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} ${input.slot} projection is not ready at ${documentPath}.`,
    );
  const overridden = input.bodyOverrides?.get(documentPath);
  return {
    packagePath: task.packagePath,
    path: documentPath,
    body: overridden ?? documentRead.document.body,
    blobSha256: overridden === undefined ? documentRead.document.blobSha256 : sha256Text(overridden),
    workspaceRevision: documentRead.document.workspaceRevision,
    source: overridden === undefined ? "canonical projection" : "submitted candidate",
    contract: transitionDocumentReadinessContract({
      contract,
      descriptor,
      ...(input.readBlob ? { readBlob: input.readBlob } : {}),
    }),
  };
}

export function assertTaskTransitionDocumentReady(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly transition: string;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
  readonly readBlob?: TransitionDocumentBlobReader;
}): TaskTransitionDocument {
  const kind = requireTransitionDocumentKind(input.transition);
  if (kind !== input.slot)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Transition ${input.transition} consumes ${kind}, not ${input.slot}.`,
    );
  const document = readTaskTransitionDocument(input);
  if (document.contract === null)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} ${input.slot} scaffold is unavailable for readiness.`,
    );
  try {
    assertTransitionDocumentReady(kind, document.body, document.contract);
  } catch (error) {
    if (error && typeof error === "object") {
      const projectedMissing = transitionMissingSections(error),
        diskBody = document.source === "canonical projection" ? readOnDiskBody(input.rootDir, document.path) : null,
        diskDiffers = diskBody !== null && diskBody !== document.body,
        actionableMissing =
          diskDiffers && document.contract !== null
            ? assessTransitionDocument(kind, diskBody, document.contract).missingSections
            : projectedMissing,
        revision =
          document.source === "canonical projection"
            ? `canonical projection document at workspace revision ${document.workspaceRevision}`
            : `submitted candidate against canonical projection workspace revision ${document.workspaceRevision}`,
        diagnosticSummary = actionableMissing.length
          ? `${actionableMissing.length} required section` +
            `${actionableMissing.length === 1 ? " is" : "s are"} incomplete.`
          : "No missing required sections were reported.";
      Object.assign(error, {
        documentPath: document.path,
        diskDiffers,
        missingSections: actionableMissing,
        projectedMissingSections: projectedMissing,
        message: [
          `${String((error as { readonly code?: unknown }).code ?? "content_not_ready")}:`,
          `${kind} readiness judged the ${revision} (blob sha256 ${document.blobSha256}).`,
          diagnosticSummary,
        ].join(" "),
      });
    }
    throw error;
  }
  return document;
}

function readOnDiskBody(rootDir: string, documentPath: string): string | null {
  const target = path.join(resolveHarnessLayout(rootDir).authoredRoot, ...documentPath.split("/"));
  return existsSync(target) && !lstatSync(target).isSymbolicLink() && lstatSync(target).isFile()
    ? readFileSync(target, "utf8")
    : null;
}

function transitionMissingSections(error: object): readonly TransitionDocumentMissingSection[] {
  return "missingSections" in error && Array.isArray(error.missingSections)
    ? error.missingSections.filter(
        (value): value is TransitionDocumentMissingSection =>
          value !== null &&
          typeof value === "object" &&
          "section" in value &&
          typeof value.section === "string" &&
          "reason" in value &&
          (value.reason === "empty" || value.reason === "scaffold") &&
          (value.reason === "empty" || ("retainedScaffold" in value && typeof value.retainedScaffold === "string")),
      )
    : [];
}

function transitionDocumentAccessError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
