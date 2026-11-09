import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assessTransitionDocument,
  assertTransitionDocumentReady,
  completionContractGap,
  documentWorkspacePath,
  normalizeRelativeDocumentPath,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  sha256Text,
  transitionDocumentContract,
  type TaskProjectionQueries,
  type MarkdownDocumentContract,
  type TaskProjection,
} from "@harness-anything/kernel";
import { loadCanonicalAssets } from "@harness-anything/preset/internal/preset-assets";
import { safeTemplatePath } from "@harness-anything/preset/internal/preset-materialization";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import type { CatalogSource } from "@harness-anything/preset/internal/preset-resolver-types";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";

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
  /** Every template heading frozen beside the readiness map, when the descriptor carries it. */
  readonly readinessKnownSections?: unknown;
}

/**
 * Resolves the readiness contract a task package's scaffold declared: the contract frozen into the
 * descriptor at materialization first, then — for packages materialized before descriptors carried
 * it — the bundled template catalog the descriptor's `templateRef` names. The frozen map is
 * authoritative and costs no file read; only a package that predates it falls back to the catalog.
 * Returns null when no source yields the contract.
 */
export function transitionDocumentReadinessContract(input: {
  readonly contract: unknown;
  readonly descriptor: TransitionDocumentDescriptor;
}): MarkdownDocumentContract | null {
  const embedded = embeddedReadinessContract(input.descriptor.readiness, input.descriptor.readinessKnownSections);
  if (embedded) return embedded;
  const catalog = catalogReadinessSource(input.contract, input.descriptor);
  // A package materialized before descriptors carried the frozen contract is judged only by the
  // catalog's baseline anchors. A conditional section declared later never backfills an old plan.
  return catalog === null ? null : transitionDocumentContract(catalog.body, catalog.requiredAnchors);
}

function embeddedReadinessContract(value: unknown, knownSectionsValue: unknown): MarkdownDocumentContract | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const scaffoldBySection: Record<string, readonly string[]> = {};
  for (const [section, lines] of Object.entries(value)) {
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) return null;
    scaffoldBySection[section] = lines;
  }
  const knownSections =
    Array.isArray(knownSectionsValue) && knownSectionsValue.every((section) => typeof section === "string")
      ? Object.freeze([...knownSectionsValue] as readonly string[])
      : undefined;
  return {
    requiredSections: Object.keys(scaffoldBySection),
    scaffoldBySection,
    ...(knownSections === undefined ? {} : { knownSections }),
  };
}

// dec_5F7E74F1 renamed the create-milestone plan template to the work plan (same sections). Task contracts are
// immutable, so packages created before the rename still cite the old ref.
const renamedTemplateRefs: Readonly<Record<string, string>> = Object.freeze({
  "template://planning/milestone-task-plan@1": "template://planning/work-task-plan@1",
});

function catalogReadinessSource(
  contract: unknown,
  descriptor: TransitionDocumentDescriptor,
): { readonly body: string; readonly requiredAnchors: readonly string[] } | null {
  const cited = descriptor.templateRef;
  if (typeof cited !== "string" || !cited) return null;
  const templateRef = Object.hasOwn(renamedTemplateRefs, cited) ? renamedTemplateRefs[cited] : cited,
    locale =
      typeof descriptor.locale === "string" && descriptor.locale
        ? descriptor.locale
        : contract && typeof contract === "object" && !Array.isArray(contract)
          ? (contract as { readonly locale?: unknown }).locale
          : undefined,
    assets = loadCatalogAssets();
  if (assets === null || typeof locale !== "string") return null;
  const document = assets.catalog.documents.find((item) => `template://${item.id}@${item.version}` === templateRef),
    variant = document?.locales.find((item) => item.locale === locale) ?? document?.locales[0];
  if (!document || !variant) return null;
  const target = safeTemplatePath(assets.root, variant.bodyPath, templateRef),
    stat = existsSync(target) ? lstatSync(target) : undefined;
  return stat?.isFile() && !stat.isSymbolicLink()
    ? { body: readFileSync(target, "utf8"), requiredAnchors: document.requiredAnchors }
    : null;
}

let bundledCatalog: CatalogSource | null | undefined;

function loadCatalogAssets(): CatalogSource | null {
  if (bundledCatalog === undefined)
    bundledCatalog = existsSync(path.join(defaultAssets, "template-catalog.json"))
      ? loadCanonicalAssets(defaultAssets).catalog
      : null;
  return bundledCatalog;
}

/**
 * Where the contract's document for a slot stands, without failing on older packages: not
 * declared by the contract (an older contract generation), declared but not yet written, or
 * written; with the readiness contract its scaffold declares, or null when none resolves. A
 * projection that has not caught up counts as written so the reader reports it.
 */
export function locateTaskTransitionDocument(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
}) {
  const task = input.projection.read(input.taskId);
  if (task.watermark < task.sourceRevision || !task.snapshot.task || !task.packagePath)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} package projection is not ready for ${input.slot}.`,
    );
  const packagePath = task.packagePath,
    contractPath = `${packagePath}/task-contract.json`,
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
  if (!descriptor) return { packagePath, contract, descriptor, path: null };
  let documentPath: string;
  try {
    documentPath = normalizeRelativeDocumentPath(`${packagePath}/${descriptor.path}`);
  } catch {
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} path is invalid.`);
  }
  if (!documentPath.startsWith(`${packagePath}/`))
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} leaves its package.`);
  return { packagePath, contract, descriptor, path: documentPath };
}

export function readTaskTransitionDocument(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
}): TaskTransitionDocument {
  const { packagePath, contract, descriptor, path: documentPath } = locateTaskTransitionDocument(input);
  if (!descriptor || documentPath === null)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} contract has no ${input.slot} document.`,
    );
  const documentRead = input.projection.readDocument(documentPath);
  if (documentRead.watermark < documentRead.sourceRevision || !documentRead.document)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} ${input.slot} projection is not ready at ${documentPath}.`,
    );
  const overridden = input.bodyOverrides?.get(documentPath);
  return {
    packagePath,
    path: documentPath,
    body: overridden ?? documentRead.document.body,
    blobSha256: overridden === undefined ? documentRead.document.blobSha256 : sha256Text(overridden),
    workspaceRevision: documentRead.document.workspaceRevision,
    source: overridden === undefined ? "canonical projection" : "submitted candidate",
    // The closeout is authored prose: submit extracts its sections and never compares them to a
    // scaffold (dec_E369B8616F50A6208B293997E7 CH2). Only the plan is judged against its contract.
    contract: input.slot === "task.plan" ? transitionDocumentReadinessContract({ contract, descriptor }) : null,
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
  // Start and dispatch both consume the plan. A task whose frozen preset snapshot is gone has no
  // usable completion contract, so it must be refused here — with the explicit migration — instead
  // of accepting the turn and failing at submit.
  const gap = completionContractGap(input.projection.read(input.taskId).snapshot.task);
  if (gap) throw transitionDocumentAccessError(gap.code, `${gap.reason} Run ${gap.action}.`);
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
      // The kernel judgment is pure: re-assessing the same body yields the sections the throw carried.
      const projected = assessTransitionDocument(kind, document.body, document.contract),
        projectedMissing = projected.missingSections,
        projectedUnexpected = projected.unexpectedSections,
        diskBody = document.source === "canonical projection" ? readOnDiskBody(input.rootDir, document.path) : null,
        diskDiffers = diskBody !== null && diskBody !== document.body,
        actionable =
          diskDiffers && document.contract !== null
            ? assessTransitionDocument(kind, diskBody, document.contract)
            : undefined,
        actionableMissing = actionable?.missingSections ?? projectedMissing,
        actionableUnexpected = actionable?.unexpectedSections ?? projectedUnexpected,
        revision =
          document.source === "canonical projection"
            ? `canonical projection document at workspace revision ${document.workspaceRevision}`
            : `submitted candidate against canonical projection workspace revision ${document.workspaceRevision}`,
        diagnosticSummary = [
          actionableMissing.length
            ? `${actionableMissing.length} required section` +
              `${actionableMissing.length === 1 ? " is" : "s are"} incomplete.`
            : "No missing required sections were reported.",
          actionableUnexpected.length
            ? `${actionableUnexpected.length} section` +
              `${actionableUnexpected.length === 1 ? " is" : "s are"} not in the template.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
      Object.assign(error, {
        documentPath: documentWorkspacePath(input.rootDir, document.path),
        diskDiffers,
        missingSections: actionableMissing,
        projectedMissingSections: projectedMissing,
        unexpectedSections: actionableUnexpected,
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
    ? new TextDecoder("utf-8", { fatal: true }).decode(
        readAuthoredDocumentBytes(resolveHarnessLayout(rootDir).authoredRoot, documentPath),
      )
    : null;
}

function transitionDocumentAccessError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
