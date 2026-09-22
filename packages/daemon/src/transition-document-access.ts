import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assessTransitionDocument,
  assertTransitionDocumentReady,
  normalizeRelativeDocumentPath,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  sha256Text,
  transitionDocumentContract,
  type MarkdownDocumentContract,
  type TaskProjection,
  type TaskProjectionQueries,
  type TransitionDocumentMissingSection,
} from "@harness-anything/kernel";
import { loadCanonicalAssets } from "@harness-anything/preset/internal/preset-assets";
import { safeTemplatePath } from "@harness-anything/preset/internal/preset-materialization";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import type { CatalogSource } from "@harness-anything/preset/internal/preset-resolver-types";

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

interface TransitionDocumentDescriptor {
  readonly slot: string;
  readonly path: string;
  readonly templateRef?: unknown;
  readonly locale?: unknown;
  readonly readiness?: unknown;
}

/**
 * Resolves the readiness contract a task package's scaffold declared: the contract frozen into the
 * descriptor at materialization first, then — for packages materialized before descriptors carried
 * it — the bundled template catalog the descriptor's `templateRef` names. Returns null when no
 * source yields the contract.
 */
export function transitionDocumentReadinessContract(input: {
  readonly contract: unknown;
  readonly descriptor: TransitionDocumentDescriptor;
}): MarkdownDocumentContract | null {
  const embedded = embeddedReadinessContract(input.descriptor.readiness);
  if (embedded) return embedded;
  const catalogBody = catalogScaffoldBody(input.contract, input.descriptor);
  return catalogBody === null ? null : transitionDocumentContract(catalogBody);
}

function embeddedReadinessContract(value: unknown): MarkdownDocumentContract | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const scaffoldBySection: Record<string, readonly string[]> = {};
  for (const [section, lines] of Object.entries(value)) {
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) return null;
    scaffoldBySection[section] = lines;
  }
  return { requiredSections: Object.keys(scaffoldBySection), scaffoldBySection };
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
  const target = safeTemplatePath(assets.root, variant.bodyPath, templateRef),
    stat = existsSync(target) ? lstatSync(target) : undefined;
  return stat?.isFile() && !stat.isSymbolicLink() ? readFileSync(target, "utf8") : null;
}

let bundledCatalog: CatalogSource | null | undefined;

function loadCatalogAssets(): CatalogSource | null {
  if (bundledCatalog === undefined)
    bundledCatalog = existsSync(path.join(defaultAssets, "template-catalog.json"))
      ? loadCanonicalAssets(defaultAssets).catalog
      : null;
  return bundledCatalog;
}

export function readTaskTransitionDocument(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
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
    contract: transitionDocumentReadinessContract({ contract, descriptor }),
  };
}

export function assertTaskTransitionDocumentReady(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly transition: string;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
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

export function readOnDiskBody(rootDir: string, documentPath: string): string | null {
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
