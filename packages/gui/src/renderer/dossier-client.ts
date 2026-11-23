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

/** Bounded pagination ceiling per interactive refresh action (16 * 512 = 8,192 revisions folded in memory per commit). */
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

  async context(
    repoId: string,
    slotId: string,
    maxWatermark?: number,
    options?: { readonly afterWatermark?: number; readonly bootstrap?: boolean },
  ): Promise<DossierContextRead> {
    const result = await invoke("repo.dossier.context.read", {
      repoId,
      slotId,
      ...(maxWatermark !== undefined ? { maxWatermark } : {}),
      ...(options?.afterWatermark !== undefined ? { afterWatermark: options.afterWatermark } : {}),
      ...(options?.bootstrap !== undefined ? { bootstrap: options.bootstrap } : {}),
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

function stripManagedStateForBootstrap(previousBody: string | null): string | null {
  if (!previousBody) return null;
  return previousBody.includes("<!-- dossier-state:v1 ") ? null : previousBody;
}

function boundedPageTarget(afterWatermark: number, nextWatermark: number): number {
  const delta = nextWatermark - afterWatermark;
  return delta > DOSSIER_PAGE_SIZE ? afterWatermark + DOSSIER_PAGE_SIZE : nextWatermark;
}

async function commitSynthesizedSlot(input: {
  readonly repoId: string;
  readonly slotId: string;
  readonly expectedWatermark: number;
  readonly watermark: number;
  readonly body: string;
  readonly pagesApplied: number;
  readonly remaining: boolean;
}): Promise<DossierSlotRefreshOutcome> {
  const receipt = await dossierClient.synthesize(input.repoId, {
    slotId: input.slotId,
    expectedWatermark: input.expectedWatermark,
    watermark: input.watermark,
    body: input.body,
    idempotencyKey: `gui-dossier-${input.slotId}-${input.expectedWatermark}-${input.watermark}`,
  });
  if (!receipt.ok) {
    const code =
      typeof receipt.code === "string" && receipt.code.length > 0 ? receipt.code : "dossier_synthesis_failed";
    const message = typeof receipt.hint === "string" && receipt.hint.length > 0 ? receipt.hint : code;
    return {
      ok: false,
      slotId: input.slotId,
      conflict: code === "dossier_watermark_conflict",
      code,
      message,
    };
  }
  return {
    ok: true,
    slotId: input.slotId,
    pagesApplied: input.pagesApplied,
    reachedWatermark: input.watermark,
    remaining: input.remaining,
  };
}

export async function refreshDossierSlot(input: {
  readonly repoId: string;
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly maxPages?: number;
  readonly bootstrap?: boolean;
  readonly now?: () => string;
}): Promise<DossierSlotRefreshOutcome> {
  const maxPages = input.maxPages ?? MAX_DOSSIER_REFRESH_PAGES;
  const now = input.now ?? (() => new Date().toISOString());
  const initialContent = await dossierClient.read(input.repoId, input.slot.id);
  let baseBody = initialContent.body;
  let heldWatermark = initialContent.state?.lastSynthesizedWatermark ?? 0;

  const firstAligned = await readAlignedContextPage({
    repoId: input.repoId,
    slotId: input.slot.id,
    fixedUpperWatermark: undefined,
    previousBody: baseBody,
    heldWatermark,
  });
  if (firstAligned.status === "conflict") {
    return {
      ok: false,
      slotId: input.slot.id,
      conflict: true,
      code: "dossier_watermark_conflict",
      message: firstAligned.message,
    };
  }
  if (firstAligned.status === "caught_up") {
    return {
      ok: true,
      slotId: input.slot.id,
      pagesApplied: 0,
      reachedWatermark: firstAligned.heldWatermark,
      remaining: false,
    };
  }

  baseBody = firstAligned.previousBody;
  heldWatermark = firstAligned.heldWatermark;
  const page = firstAligned.page;
  const fixedUpperWatermark = page.currentWatermark;

  if (page.nextWatermark <= heldWatermark) {
    return {
      ok: true,
      slotId: input.slot.id,
      pagesApplied: 0,
      reachedWatermark: heldWatermark,
      remaining: false,
    };
  }

  const canAutoBootstrap =
    input.bootstrap === true ||
    (input.bootstrap !== false &&
      input.maxPages === undefined &&
      !page.done &&
      fixedUpperWatermark - heldWatermark > maxPages * DOSSIER_PAGE_SIZE);

  if (canAutoBootstrap) {
    const bootPage = await dossierClient.context(input.repoId, input.slot.id, undefined, { bootstrap: true });
    if (bootPage.expectedWatermark === heldWatermark && bootPage.nextWatermark > heldWatermark) {
      const body = synthesizeDossierDocument({
        verticalId: input.verticalId,
        slot: input.slot,
        previousBody: bootPage.bootstrapped ? stripManagedStateForBootstrap(baseBody) : baseBody,
        expectedWatermark: heldWatermark,
        targetWatermark: bootPage.nextWatermark,
        changes: bootPage.changes,
        synthesizedAt: now(),
        kindMap: bootPage.kindMap,
      });
      return commitSynthesizedSlot({
        repoId: input.repoId,
        slotId: input.slot.id,
        expectedWatermark: heldWatermark,
        watermark: bootPage.nextWatermark,
        body,
        pagesApplied: 1,
        remaining: false,
      });
    }
  }

  let cursor = boundedPageTarget(heldWatermark, page.nextWatermark);
  let workingBody: string | null = synthesizeDossierDocument({
    verticalId: input.verticalId,
    slot: input.slot,
    previousBody: baseBody,
    expectedWatermark: heldWatermark,
    targetWatermark: cursor,
    changes: page.changes,
    synthesizedAt: now(),
    kindMap: page.kindMap,
  });
  let pagesApplied = 1;
  let done = page.done || cursor >= fixedUpperWatermark;
  let midFoldRealigns = 0;

  while (!done && pagesApplied < maxPages) {
    const nextPage = await dossierClient.context(input.repoId, input.slot.id, fixedUpperWatermark, {
      afterWatermark: cursor,
    });

    if (nextPage.expectedWatermark !== heldWatermark) {
      midFoldRealigns += 1;
      if (midFoldRealigns > MAX_DOSSIER_REALIGN_RETRIES) {
        return {
          ok: false,
          slotId: input.slot.id,
          conflict: true,
          code: "dossier_watermark_conflict",
          message: `Slot ${input.slot.id} advanced concurrently from r${heldWatermark} to r${nextPage.expectedWatermark}.`,
        };
      }
      const latest = await dossierClient.read(input.repoId, input.slot.id);
      baseBody = latest.body;
      heldWatermark = latest.state?.lastSynthesizedWatermark ?? 0;
      if (heldWatermark >= fixedUpperWatermark) {
        return {
          ok: true,
          slotId: input.slot.id,
          pagesApplied: 0,
          reachedWatermark: heldWatermark,
          remaining: false,
        };
      }
      let activePage = nextPage;
      if (
        activePage.expectedWatermark !== heldWatermark ||
        (activePage.afterWatermark !== undefined && activePage.afterWatermark > heldWatermark)
      ) {
        const realigned = await readAlignedContextPage({
          repoId: input.repoId,
          slotId: input.slot.id,
          fixedUpperWatermark,
          previousBody: baseBody,
          heldWatermark,
        });
        if (realigned.status === "conflict") {
          return {
            ok: false,
            slotId: input.slot.id,
            conflict: true,
            code: "dossier_watermark_conflict",
            message: realigned.message,
          };
        }
        if (realigned.status === "caught_up") {
          return {
            ok: true,
            slotId: input.slot.id,
            pagesApplied: 0,
            reachedWatermark: realigned.heldWatermark,
            remaining: false,
          };
        }
        baseBody = realigned.previousBody;
        heldWatermark = realigned.heldWatermark;
        activePage = realigned.page;
      }
      cursor = boundedPageTarget(heldWatermark, activePage.nextWatermark);
      workingBody = synthesizeDossierDocument({
        verticalId: input.verticalId,
        slot: input.slot,
        previousBody: baseBody,
        expectedWatermark: heldWatermark,
        targetWatermark: cursor,
        changes: activePage.changes,
        synthesizedAt: now(),
        kindMap: activePage.kindMap,
      });
      pagesApplied = 1;
      done = activePage.done || cursor >= fixedUpperWatermark;
      continue;
    }

    if (nextPage.nextWatermark <= cursor) {
      done = true;
      break;
    }

    const nextTarget = boundedPageTarget(cursor, nextPage.nextWatermark);
    workingBody = synthesizeDossierDocument({
      verticalId: input.verticalId,
      slot: input.slot,
      previousBody: workingBody,
      expectedWatermark: cursor,
      targetWatermark: nextTarget,
      changes: nextPage.changes,
      synthesizedAt: now(),
      kindMap: nextPage.kindMap,
    });
    cursor = nextTarget;
    pagesApplied += 1;
    done = nextPage.done || cursor >= fixedUpperWatermark;
  }

  return commitSynthesizedSlot({
    repoId: input.repoId,
    slotId: input.slot.id,
    expectedWatermark: heldWatermark,
    watermark: cursor,
    body: workingBody!,
    pagesApplied,
    remaining: !done,
  });
}
