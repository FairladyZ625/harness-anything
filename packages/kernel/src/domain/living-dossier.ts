import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { DOSSIER_PAGE_SIZE } from "./living-dossier-synthesizer.ts";

export const DOSSIER_DIRECTORY = "dossiers/";
export { DOSSIER_PAGE_SIZE };
export const DOSSIER_DOCUMENT_OWNER = "living-dossier/v1";
export const DOSSIER_VERTICAL_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u;
export const DOSSIER_SLOT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const DOSSIER_ANCHOR_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;

export type DossierTrigger =
  | { readonly kind: "periodic"; readonly everyMs: number }
  | { readonly kind: "event-watermark"; readonly minimumDelta: number };

export interface DossierSlot {
  readonly id: string;
  /** Portable path relative to the active vertical's dossier directory. */
  readonly path: string;
  readonly kind: "markdown" | "html";
  readonly title: string;
  readonly summary: string;
  readonly entityKinds: readonly string[];
  readonly requiredAnchors: readonly string[];
  readonly watermarkMetadata: "required";
  readonly triggers: readonly DossierTrigger[];
}

export interface LivingDossier {
  readonly slots: readonly DossierSlot[];
}

export interface DossierSlotState {
  readonly verticalId: string;
  readonly slotId: string;
  readonly lastSynthesizedWatermark: number;
  readonly synthesizedAt: string;
  readonly path: string;
}

export function dossierRoot(verticalId: string): string {
  return `${DOSSIER_DIRECTORY}${verticalId.replaceAll("/", "+")}/`;
}

export function dossierDocumentPath(verticalId: string, slot: Pick<DossierSlot, "path">): string {
  return normalizeRelativeDocumentPath(`${dossierRoot(verticalId)}${slot.path}`);
}

export function dossierStatePath(verticalId: string, slotId: string): string {
  return dossierDocumentPath(verticalId, { path: `.state/${slotId}.json` });
}

export function dossierMediaType(kind: DossierSlot["kind"]): "text/markdown" | "text/html" {
  return kind === "markdown" ? "text/markdown" : "text/html";
}

export function isDossierWatermark(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateDossierSlots(
  verticalId: string,
  dossier: LivingDossier,
  entityKinds: ReadonlySet<string>,
): void {
  if (!DOSSIER_VERTICAL_ID_PATTERN.test(verticalId)) invalidDossier("livingDossier requires a portable vertical id");
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const slot of dossier.slots) {
    const path = normalizeRelativeDocumentPath(slot.path);
    const extension = slot.kind === "markdown" ? ".md" : ".html";
    const key = path.toLowerCase();
    if (path !== slot.path || !key.endsWith(extension) || key.startsWith(".state/"))
      invalidDossier(`livingDossier slot ${slot.id} requires a canonical ${extension} path`);
    if (ids.has(slot.id) || paths.has(key)) invalidDossier(`livingDossier slot ${slot.id} repeats an id or path`);
    if (new Set(slot.requiredAnchors).size !== slot.requiredAnchors.length)
      invalidDossier(`livingDossier slot ${slot.id} repeats a required anchor`);
    if (
      new Set(slot.entityKinds).size !== slot.entityKinds.length ||
      slot.entityKinds.some((kind) => !entityKinds.has(kind))
    )
      invalidDossier(`livingDossier slot ${slot.id} repeats or references an undeclared entity kind`);
    if (new Set(slot.triggers.map(({ kind }) => kind)).size !== slot.triggers.length)
      invalidDossier(`livingDossier slot ${slot.id} repeats a trigger kind`);
    ids.add(slot.id);
    paths.add(key);
  }
  for (const path of paths) {
    const parents = path.split("/").slice(0, -1);
    while (parents.length > 0) {
      if (paths.has(parents.join("/"))) invalidDossier(`livingDossier path ${path} overlaps another slot`);
      parents.pop();
    }
  }
}

function invalidDossier(message: string): never {
  throw new DossierError("invalid_vertical_contract", message);
}

export class DossierError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
