import {
  DOSSIER_PAGE_SIZE,
  synthesizeDossierDocument,
  type DossierContentRead,
  type DossierContextRead,
  type DossierSlot,
  type DossierStatusRead,
  type GuiActionResult,
} from "../api/renderer-dto.ts";
import { invoke } from "./api-client-invoke.ts";
import { readGuiActionResult } from "./command-receipt.ts";
import { localErrorHint } from "./result-validation.ts";

/** Bounded pagination ceiling per interactive refresh action (16 * 64 = 1,024 revisions per click). */
export const MAX_DOSSIER_REFRESH_PAGES = 16;
/** Bounded realignment retries when another writer advances the slot between read and context. */
export const MAX_DOSSIER_REALIGN_RETRIES = 3;

export const dossierQueryKeys = {
  all: (repoId: string) => ["dossier", repoId] as const,
  status: (repoId: string) => ["dossier", repoId, "status"] as const,
  read: (repoId: string, slotId: string) => ["dossier", repoId, "read", slotId] as const,
};

export interface DossierSynthesizePayload {
  readonly slotId: string;
  readonly expectedWatermark: number;
  readonly watermark: number;
  readonly body: string;
  readonly idempotencyKey?: string;
}

export type DossierSlotRefreshOutcome =
  | {
      readonly ok: true;
      readonly slotId: string;
      readonly pagesApplied: number;
      readonly reachedWatermark: number;
      readonly remaining: boolean;
    }
  | {
      readonly ok: false;
      readonly slotId: string;
      readonly conflict: boolean;
      readonly code: string;
      readonly message: string;
    };

export const dossierClient = {
  async status(repoId: string): Promise<DossierStatusRead> {
    const result = await invoke("repo.dossier.status", { repoId });
    if (!result || result.schema !== "dossier-status/v1" || !Array.isArray(result.slots)) {
      throw new Error(localErrorHint(result, "Living dossier status read returned an invalid result."));
    }
    return result;
  },

  async read(repoId: string, slotId: string): Promise<DossierContentRead> {
    const result = await invoke("repo.dossier.read", { repoId, slotId });
    if (!result || result.schema !== "dossier-content/v1" || !result.slot) {
      throw new Error(localErrorHint(result, "Living dossier slot read returned an invalid result."));
    }
    return result;
  },

  async context(repoId: string, slotId: string, maxWatermark?: number): Promise<DossierContextRead> {
    const result = await invoke("repo.dossier.context.read", {
      repoId,
      slotId,
      ...(maxWatermark !== undefined ? { maxWatermark } : {}),
    });
    if (!result || result.schema !== "dossier-context/v1" || !Array.isArray(result.changes)) {
      throw new Error(localErrorHint(result, "Living dossier context read returned an invalid result."));
    }
    return result;
  },

  async synthesize(repoId: string, payload: DossierSynthesizePayload): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.dossier.synthesize", { repoId, ...payload }));
  },
};

async function readAlignedContextPage(input: {
  readonly repoId: string;
  readonly slotId: string;
  readonly fixedUpperWatermark: number | undefined;
  readonly previousBody: string | null;
  readonly heldWatermark: number;
}): Promise<
  | {
      readonly status: "aligned";
      readonly page: DossierContextRead;
      readonly previousBody: string | null;
      readonly heldWatermark: number;
    }
  | {
      readonly status: "caught_up";
      readonly heldWatermark: number;
    }
  | {
      readonly status: "conflict";
      readonly message: string;
    }
> {
  let previousBody = input.previousBody;
  let heldWatermark = input.heldWatermark;

  for (let realignPass = 0; realignPass <= MAX_DOSSIER_REALIGN_RETRIES; realignPass += 1) {
    if (input.fixedUpperWatermark !== undefined && heldWatermark >= input.fixedUpperWatermark) {
      return { status: "caught_up", heldWatermark };
    }
    const candidate = await dossierClient.context(input.repoId, input.slotId, input.fixedUpperWatermark);
    if (candidate.expectedWatermark === heldWatermark) {
      return { status: "aligned", page: candidate, previousBody, heldWatermark };
    }
    if (realignPass === MAX_DOSSIER_REALIGN_RETRIES) {
      return {
        status: "conflict",
        message: `Slot ${input.slotId} advanced concurrently from r${heldWatermark} to r${candidate.expectedWatermark}.`,
      };
    }
    const latest = await dossierClient.read(input.repoId, input.slotId);
    previousBody = latest.body;
    heldWatermark = latest.state?.lastSynthesizedWatermark ?? 0;
  }

  return {
    status: "conflict",
    message: `Slot ${input.slotId} watermark changed concurrently.`,
  };
}

export async function refreshDossierSlot(input: {
  readonly repoId: string;
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly maxPages?: number;
  readonly now?: () => string;
}): Promise<DossierSlotRefreshOutcome> {
  const maxPages = input.maxPages ?? MAX_DOSSIER_REFRESH_PAGES;
  const now = input.now ?? (() => new Date().toISOString());
  const initialContent = await dossierClient.read(input.repoId, input.slot.id);
  let previousBody = initialContent.body;
  let heldWatermark = initialContent.state?.lastSynthesizedWatermark ?? 0;
  let pagesApplied = 0;
  let reachedWatermark = heldWatermark;
  let fixedUpperWatermark: number | undefined = undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const aligned = await readAlignedContextPage({
      repoId: input.repoId,
      slotId: input.slot.id,
      fixedUpperWatermark,
      previousBody,
      heldWatermark,
    });
    if (aligned.status === "conflict") {
      return {
        ok: false,
        slotId: input.slot.id,
        conflict: true,
        code: "dossier_watermark_conflict",
        message: aligned.message,
      };
    }
    if (aligned.status === "caught_up") {
      return {
        ok: true,
        slotId: input.slot.id,
        pagesApplied,
        reachedWatermark: aligned.heldWatermark,
        remaining: false,
      };
    }
    previousBody = aligned.previousBody;
    const { page } = aligned;

    if (fixedUpperWatermark === undefined) fixedUpperWatermark = page.currentWatermark;
    if (page.nextWatermark <= page.expectedWatermark) {
      return {
        ok: true,
        slotId: input.slot.id,
        pagesApplied,
        reachedWatermark: page.expectedWatermark,
        remaining: false,
      };
    }
    const delta = page.nextWatermark - page.expectedWatermark;
    const boundedTarget = delta > DOSSIER_PAGE_SIZE ? page.expectedWatermark + DOSSIER_PAGE_SIZE : page.nextWatermark;
    const body = synthesizeDossierDocument({
      verticalId: input.verticalId,
      slot: input.slot,
      previousBody,
      expectedWatermark: page.expectedWatermark,
      targetWatermark: boundedTarget,
      changes: page.changes,
      synthesizedAt: now(),
      kindMap: page.kindMap,
    });
    const receipt = await dossierClient.synthesize(input.repoId, {
      slotId: input.slot.id,
      expectedWatermark: page.expectedWatermark,
      watermark: boundedTarget,
      body,
      idempotencyKey: `gui-dossier-${input.slot.id}-${page.expectedWatermark}-${boundedTarget}`,
    });
    if (!receipt.ok) {
      const code =
        typeof receipt.code === "string" && receipt.code.length > 0 ? receipt.code : "dossier_synthesis_failed";
      const message = typeof receipt.hint === "string" && receipt.hint.length > 0 ? receipt.hint : code;
      return {
        ok: false,
        slotId: input.slot.id,
        conflict: code === "dossier_watermark_conflict",
        code,
        message,
      };
    }
    previousBody = body;
    heldWatermark = boundedTarget;
    pagesApplied += 1;
    reachedWatermark = boundedTarget;
    if (page.done || boundedTarget >= page.currentWatermark) {
      return {
        ok: true,
        slotId: input.slot.id,
        pagesApplied,
        reachedWatermark,
        remaining: false,
      };
    }
  }

  return {
    ok: true,
    slotId: input.slot.id,
    pagesApplied,
    reachedWatermark,
    remaining: true,
  };
}
