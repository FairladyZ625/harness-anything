// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import type { DossierContentRead, DossierContextRead, DossierStatusRead } from "../src/api/renderer-dto.ts";
import { LivingDossierView } from "../src/renderer/views/LivingDossierView.tsx";
import { dossierClient } from "../src/renderer/dossier-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const atlasSlot = {
  id: "project-atlas",
  path: "project-atlas.html",
  documentPath: "dossiers/software+coding/project-atlas.html",
  kind: "html" as const,
  title: "Project Atlas",
  summary: "System architecture topology and entity map.",
  entityKinds: ["task", "decision", "fact"],
  requiredAnchors: ["atlas-topology", "entity-map", "change-ledger"],
  watermarkMetadata: "required" as const,
  triggers: [{ kind: "event-watermark" as const, minimumDelta: 5 }],
};

const contextSlot = {
  id: "context",
  path: "CONTEXT.md",
  documentPath: "dossiers/software+coding/CONTEXT.md",
  kind: "markdown" as const,
  title: "Domain Context",
  summary: "System boundaries and verified facts.",
  entityKinds: ["task", "decision", "fact"],
  requiredAnchors: ["overview", "active-invariants", "recent-changes"],
  watermarkMetadata: "required" as const,
  triggers: [{ kind: "periodic" as const, everyMs: 86_400_000 }],
};

const sampleHtml = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="dossier-watermark" content="10"><title>Project Atlas</title></head>',
  '<body><main><section id="atlas-topology"><svg viewBox="0 0 200 60" role="img"><rect x="4" y="4" width="120" height="40"/><text x="12" y="28">software/coding</text></svg></section>',
  '<section id="entity-map"><p>Tracked 3 entity kinds.</p></section><section id="change-ledger"><p>r10 cut</p></section></main></body></html>',
].join("\n");

const sampleMarkdown = [
  "<!-- dossier-watermark: 10 -->",
  "# Domain Context",
  "<!-- dossier-anchor: overview -->",
  "## Overview",
  "Core architecture invariants captured at revision r10.",
].join("\n");

const mounted: { root: Root; client: QueryClient }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

notifyManager.setScheduler(queueMicrotask);

function mountView() {
  const host = document.createElement("div");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, client });
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, createElement(LivingDossierView, { repoId: "repo-1" })));
  });
  return { host, client };
}

async function settle(client: QueryClient) {
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => undefined);
}

describe("LivingDossierView", () => {
  it("renders slot freshness, switches between sandboxed HTML iframe and Markdown DocReader, and filters kinds", async () => {
    const statusPayload: DossierStatusRead = {
      schema: "dossier-status/v1",
      verticalId: "software/coding",
      currentWatermark: 18,
      slots: [
        {
          ...atlasSlot,
          lastSynthesizedWatermark: 10,
          synthesizedAt: "2026-11-22T10:00:00.000Z",
          stalenessDelta: 8,
          dueTriggers: [{ kind: "event-watermark", minimumDelta: 5 }],
        },
        {
          ...contextSlot,
          lastSynthesizedWatermark: 10,
          synthesizedAt: "2026-11-22T10:00:00.000Z",
          stalenessDelta: 8,
          dueTriggers: [],
        },
      ],
    };
    vi.spyOn(dossierClient, "status").mockResolvedValue(statusPayload);
    vi.spyOn(dossierClient, "read").mockImplementation(async (_repoId, slotId): Promise<DossierContentRead> => {
      if (slotId === "project-atlas") {
        return {
          schema: "dossier-content/v1",
          slot: atlasSlot,
          state: {
            verticalId: "software/coding",
            slotId: "project-atlas",
            lastSynthesizedWatermark: 10,
            synthesizedAt: "2026-11-22T10:00:00.000Z",
            path: atlasSlot.documentPath,
          },
          mediaType: "text/html",
          body: sampleHtml,
        };
      }
      return {
        schema: "dossier-content/v1",
        slot: contextSlot,
        state: {
          verticalId: "software/coding",
          slotId: "context",
          lastSynthesizedWatermark: 10,
          synthesizedAt: "2026-11-22T10:00:00.000Z",
          path: contextSlot.documentPath,
        },
        mediaType: "text/markdown",
        body: sampleMarkdown,
      };
    });

    const { client } = mountView();
    await settle(client);

    expect(document.querySelector("[data-testid='dossier-header-meta']")?.textContent).toContain("software/coding");
    expect(document.querySelector("[data-testid='dossier-header-meta']")?.textContent).toContain("r18");
    expect(document.querySelector("[data-testid='dossier-active-freshness']")?.textContent).toContain("Δ8");

    const iframe = document.querySelector<HTMLIFrameElement>("[data-testid='dossier-html-frame']");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("");
    expect(iframe?.getAttribute("srcdoc")).toContain("<svg");
    expect(iframe?.getAttribute("srcdoc")).not.toContain("<script");

    // Switch to Markdown slot
    await act(async () => {
      document
        .querySelector("[data-testid='dossier-slot-row-context'] button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);

    expect(document.querySelector("[data-testid='dossier-html-frame']")).toBeNull();
    expect(document.querySelector("[data-testid='doc-reader']")?.textContent).toContain("Core architecture invariants");
    expect(document.querySelector("[data-testid='dossier-markdown-status']")?.textContent).toBe("r10 / r18");
  });

  it("paginates incremental synthesis across 64-revision pages from an unsynthesized slot", async () => {
    let synthesizedWatermark = 0;
    let storedBody: string | null = null;

    vi.spyOn(dossierClient, "status").mockImplementation(
      async (): Promise<DossierStatusRead> => ({
        schema: "dossier-status/v1",
        verticalId: "office/collab",
        currentWatermark: 100,
        slots: [
          {
            ...atlasSlot,
            documentPath: "dossiers/office+collab/project-atlas.html",
            lastSynthesizedWatermark: synthesizedWatermark,
            synthesizedAt: synthesizedWatermark > 0 ? "2026-11-22T11:00:00.000Z" : null,
            stalenessDelta: 100 - synthesizedWatermark,
            dueTriggers: synthesizedWatermark < 100 ? [{ kind: "event-watermark", minimumDelta: 5 }] : [],
          },
        ],
      }),
    );

    vi.spyOn(dossierClient, "read").mockImplementation(
      async (): Promise<DossierContentRead> => ({
        schema: "dossier-content/v1",
        slot: atlasSlot,
        state:
          synthesizedWatermark > 0
            ? {
                verticalId: "office/collab",
                slotId: "project-atlas",
                lastSynthesizedWatermark: synthesizedWatermark,
                synthesizedAt: "2026-11-22T11:00:00.000Z",
                path: "dossiers/office+collab/project-atlas.html",
              }
            : null,
        mediaType: "text/html",
        body: storedBody,
      }),
    );

    const contextSpy = vi.spyOn(dossierClient, "context").mockImplementation(async (): Promise<DossierContextRead> => {
      if (synthesizedWatermark === 0) {
        return {
          schema: "dossier-context/v1",
          slotId: "project-atlas",
          expectedWatermark: 0,
          currentWatermark: 100,
          nextWatermark: 64,
          done: false,
          changes: [
            {
              eventId: "evt_p1",
              schema: "decision-event/v1",
              type: "decision_accepted",
              occurredAt: "2026-11-22T09:00:00.000Z",
              workspaceRevision: 40,
              source: "local",
              actor: { principal: { personId: "person_alice" } },
              payload: { title: "Approve Q4 brief" },
              entityRefs: ["decision/dec_p1"],
            },
          ],
        };
      }
      return {
        schema: "dossier-context/v1",
        slotId: "project-atlas",
        expectedWatermark: 64,
        currentWatermark: 100,
        nextWatermark: 100,
        done: true,
        changes: [
          {
            eventId: "evt_p2",
            schema: "task-event/v1",
            type: "task_completed",
            occurredAt: "2026-11-22T10:00:00.000Z",
            workspaceRevision: 92,
            source: "local",
            actor: { executor: { id: "contributor" } },
            payload: { title: "Complete launch handoff" },
            entityRefs: ["task/task_p2"],
          },
        ],
      };
    });

    const synthSpy = vi.spyOn(dossierClient, "synthesize").mockImplementation(async (_repoId, payload) => {
      synthesizedWatermark = payload.watermark;
      storedBody = payload.body;
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "dossier-synthesize",
        outcome: "applied",
        opId: `op_${payload.watermark}`,
      };
    });

    const { client } = mountView();
    await settle(client);

    expect(document.querySelector("[data-testid='dossier-unsynthesized']")).not.toBeNull();
    await act(async () => {
      document
        .querySelector("[data-testid='dossier-generate-empty']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);

    expect(contextSpy).toHaveBeenCalledTimes(2);
    expect(synthSpy).toHaveBeenCalledTimes(2);
    expect(synthSpy.mock.calls[0]?.[1]).toMatchObject({ expectedWatermark: 0, watermark: 64 });
    expect(synthSpy.mock.calls[1]?.[1]).toMatchObject({ expectedWatermark: 64, watermark: 100 });
    expect(document.querySelector("[data-testid='dossier-feedback']")?.textContent).toContain("r100");
    const iframe = document.querySelector<HTMLIFrameElement>("[data-testid='dossier-html-frame']");
    expect(iframe?.getAttribute("srcdoc")).toContain("Approve Q4 brief");
    expect(iframe?.getAttribute("srcdoc")).toContain("Complete launch handoff");
  });

  it("reloads status and displays inline warning on dossier_watermark_conflict", async () => {
    const statusSpy = vi.spyOn(dossierClient, "status").mockResolvedValue({
      schema: "dossier-status/v1",
      verticalId: "software/coding",
      currentWatermark: 20,
      slots: [
        {
          ...atlasSlot,
          lastSynthesizedWatermark: 10,
          synthesizedAt: "2026-11-22T10:00:00.000Z",
          stalenessDelta: 10,
          dueTriggers: [{ kind: "event-watermark", minimumDelta: 5 }],
        },
      ],
    });
    vi.spyOn(dossierClient, "read").mockResolvedValue({
      schema: "dossier-content/v1",
      slot: atlasSlot,
      state: {
        verticalId: "software/coding",
        slotId: "project-atlas",
        lastSynthesizedWatermark: 10,
        synthesizedAt: "2026-11-22T10:00:00.000Z",
        path: atlasSlot.documentPath,
      },
      mediaType: "text/html",
      body: sampleHtml,
    });
    vi.spyOn(dossierClient, "context").mockResolvedValue({
      schema: "dossier-context/v1",
      slotId: "project-atlas",
      expectedWatermark: 10,
      currentWatermark: 20,
      nextWatermark: 20,
      done: true,
      changes: [],
    });
    vi.spyOn(dossierClient, "synthesize").mockResolvedValue({
      schema: "command-receipt/v2",
      ok: false,
      command: "dossier-synthesize",
      outcome: "op_rejected",
      opId: "op_conflict",
      code: "dossier_watermark_conflict",
      hint: "Slot project-atlas has watermark 15, expected 10.",
    });

    const { client } = mountView();
    await settle(client);

    await act(async () => {
      document
        .querySelector("[data-testid='dossier-refresh-slot']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);

    expect(statusSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const feedback = document.querySelector("[data-testid='dossier-feedback']");
    expect(feedback?.getAttribute("data-notice-tone")).toBe("wait");
    expect(feedback?.textContent).toContain("水位冲突");
  });

  it("refreshes all stale slots sequentially via the header action", async () => {
    const watermarks: Record<string, number> = { "project-atlas": 10, context: 0 };
    vi.spyOn(dossierClient, "status").mockImplementation(
      async (): Promise<DossierStatusRead> => ({
        schema: "dossier-status/v1",
        verticalId: "software/coding",
        currentWatermark: 15,
        slots: [
          {
            ...atlasSlot,
            lastSynthesizedWatermark: watermarks["project-atlas"]!,
            synthesizedAt: "2026-11-22T10:00:00.000Z",
            stalenessDelta: 15 - watermarks["project-atlas"]!,
            dueTriggers: [],
          },
          {
            ...contextSlot,
            lastSynthesizedWatermark: watermarks.context!,
            synthesizedAt: watermarks.context! > 0 ? "2026-11-22T10:00:00.000Z" : null,
            stalenessDelta: 15 - watermarks.context!,
            dueTriggers: [],
          },
        ],
      }),
    );
    vi.spyOn(dossierClient, "read").mockImplementation(
      async (_repoId, slotId): Promise<DossierContentRead> => ({
        schema: "dossier-content/v1",
        slot: slotId === "project-atlas" ? atlasSlot : contextSlot,
        state: null,
        mediaType: slotId === "project-atlas" ? "text/html" : "text/markdown",
        body: slotId === "project-atlas" ? sampleHtml : null,
      }),
    );
    vi.spyOn(dossierClient, "context").mockImplementation(
      async (_repoId, slotId): Promise<DossierContextRead> => ({
        schema: "dossier-context/v1",
        slotId,
        expectedWatermark: watermarks[slotId]!,
        currentWatermark: 15,
        nextWatermark: 15,
        done: true,
        changes: [],
      }),
    );
    const synthSpy = vi.spyOn(dossierClient, "synthesize").mockImplementation(async (_repoId, payload) => {
      watermarks[payload.slotId] = payload.watermark;
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "dossier-synthesize",
        outcome: "applied",
        opId: `op_batch_${payload.slotId}`,
      };
    });

    const { client } = mountView();
    await settle(client);

    await act(async () => {
      document
        .querySelector("[data-testid='dossier-refresh-all']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);

    expect(synthSpy).toHaveBeenCalledTimes(2);
    expect(synthSpy.mock.calls.map((call) => call[1].slotId)).toEqual(["project-atlas", "context"]);
    expect(document.querySelector("[data-testid='dossier-feedback']")?.textContent).toContain("2");
  });
});
