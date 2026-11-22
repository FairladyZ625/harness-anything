import {
  compileDossierSynthesis,
  isDossierSynthesisEvent,
} from "@harness-anything/kernel/internal/domain/dossier-synthesis-event.ts";
import {
  DOSSIER_PAGE_SIZE,
  dossierDocumentPath,
  isDossierWatermark,
  type DossierSlot,
} from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import type { ActorIdentity, WriteSource } from "@harness-anything/kernel";
import {
  dossierDocumentEvent,
  dossierError,
  dossierSourceCut,
  readDossierState,
  type DossierReader,
} from "../dossier-state.ts";
import { validateDossierContent } from "./dossier-content.ts";

/** Called inside the canonical serialized write turn, so the slot compare and append share its fence. */
export function prepareDossierSynthesis(input: {
  readonly reader: DossierReader;
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly expectedWatermark: unknown;
  readonly watermark: unknown;
  readonly body: unknown;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}) {
  const { reader, verticalId, slot, expectedWatermark, watermark, body } = input;
  if (!isDossierWatermark(expectedWatermark) || !isDossierWatermark(watermark) || typeof body !== "string")
    dossierError("invalid_command", "Use integer expected and target watermarks and a dossier document body.");
  const current = readDossierState(reader, verticalId, slot.id)?.lastSynthesizedWatermark ?? 0;
  if (expectedWatermark !== current)
    dossierError(
      "dossier_watermark_conflict",
      `Slot ${slot.id} has watermark ${current}, expected ${expectedWatermark}. Read a new context page.`,
    );
  const cut = dossierSourceCut(reader);
  if (watermark <= current || watermark > cut.watermark || watermark - current > DOSSIER_PAGE_SIZE)
    dossierError("invalid_command", "The target watermark must advance within one bounded source page.");
  const prior = dossierDocumentEvent(reader, dossierDocumentPath(verticalId, slot));
  if (prior !== null && (!isDossierSynthesisEvent(prior) || prior.payload.state.slotId !== slot.id))
    dossierError("dossier_path_conflict", `Dossier path ${slot.path} belongs to another document.`);
  validateDossierContent(slot, body, watermark);
  return compileDossierSynthesis({
    ...input,
    expectedWatermark,
    watermark,
    body,
    sourceWatermark: cut.watermark,
    workspaceRevision: cut.revision + 1,
  });
}
