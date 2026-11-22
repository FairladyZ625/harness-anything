// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import {
  synthesizeDossierDocument,
  type DossierContentRead,
  type DossierContextRead,
  type DossierStatusRead,
} from "../src/api/renderer-dto.ts";
import { LivingDossierView, type LivingDossierViewProps } from "../src/renderer/views/LivingDossierView.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import { dossierClient, refreshDossierSlot } from "../src/renderer/dossier-client.ts";
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

function mountView(props: Partial<LivingDossierViewProps> = {}) {
  const host = document.createElement("div");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, client });
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(LivingDossierView, { repoId: "repo-1", ...props })),
    );
  });
  return { host, client };
}

async function settle(client: QueryClient) {
  await act(async () => {
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  });
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
          kindMap: {},
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
              matchedKinds: ["decision"],
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
        kindMap: {},
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
            matchedKinds: ["task"],
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
      kindMap: {},
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
    vi.spyOn(dossierClient, "read").mockImplementation(async (_repoId, slotId): Promise<DossierContentRead> => {
      const wm = watermarks[slotId]!;
      const slot = slotId === "project-atlas" ? atlasSlot : contextSlot;
      return {
        schema: "dossier-content/v1",
        slot,
        state:
          wm > 0
            ? {
                verticalId: "software/coding",
                slotId,
                lastSynthesizedWatermark: wm,
                synthesizedAt: "2026-11-22T10:00:00.000Z",
                path: slot.documentPath,
              }
            : null,
        mediaType: slotId === "project-atlas" ? "text/html" : "text/markdown",
        body: slotId === "project-atlas" ? sampleHtml : null,
      };
    });
    vi.spyOn(dossierClient, "context").mockImplementation(
      async (_repoId, slotId): Promise<DossierContextRead> => ({
        schema: "dossier-context/v1",
        slotId,
        expectedWatermark: watermarks[slotId]!,
        currentWatermark: 15,
        nextWatermark: 15,
        done: true,
        kindMap: {},
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

  it("opens a Work Explainer via the shared WorkExplainerDocument reader and triggers callbacks (F-DOSSIER-04)", async () => {
    vi.spyOn(dossierClient, "status").mockResolvedValue({
      schema: "dossier-status/v1",
      verticalId: "software/coding",
      currentWatermark: 24,
      slots: [
        {
          ...atlasSlot,
          lastSynthesizedWatermark: 24,
          synthesizedAt: "2026-11-23T01:00:00.000Z",
          stalenessDelta: 0,
          dueTriggers: [],
        },
      ],
    });
    vi.spyOn(dossierClient, "read").mockResolvedValue({
      schema: "dossier-content/v1",
      slot: atlasSlot,
      state: {
        verticalId: "software/coding",
        slotId: "project-atlas",
        lastSynthesizedWatermark: 24,
        synthesizedAt: "2026-11-23T01:00:00.000Z",
        path: atlasSlot.documentPath,
      },
      mediaType: "text/html",
      body: sampleHtml,
    });
    const listDocsSpy = vi.spyOn(harnessClient, "getTaskDocuments").mockResolvedValue({
      ok: true,
      status: "ready",
      taskId: "work_alpha",
      watermark: 24,
      sourceRevision: 24,
      documents: [
        {
          path: "artifacts/explainer.html",
          blobSha256: "sha256:explainer",
          size: 128,
          mediaType: "text/html",
          uncommitted: false,
        },
      ],
    });
    const getDocSpy = vi.spyOn(harnessClient, "getTaskDocument").mockResolvedValue({
      ok: true,
      status: "ready",
      taskId: "work_alpha",
      path: "artifacts/explainer.html",
      repositoryPath: "harness/tasks/work_alpha-alpha-platform/artifacts/explainer.html",
      canonicalVersion: { workspaceRevision: 24, blobSha256: "sha256:explainer", size: 128 },
      watermark: 24,
      sourceRevision: 24,
      source: "canonical",
      syncState: "synced",
      uncommitted: false,
      contentKind: "text",
      mediaType: "text/html",
      body: "<!doctype html><html><body><h1>Alpha Work Explainer</h1><p>Derived progress page.</p></body></html>",
      worktreeBody: null,
    });
    const onOpenWorkExplainer = vi.fn();
    const onOpenWork = vi.fn();

    const { client } = mountView({
      works: [{ workId: "work_alpha", title: "Alpha Platform Work", status: "active" }],
      onOpenWorkExplainer,
      onOpenWork,
    });
    await settle(client);

    expect(document.querySelector("[data-testid='dossier-work-explainers']")).not.toBeNull();
    await act(async () => {
      document
        .querySelector("[data-testid='dossier-work-explainer-work_alpha'] button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);

    expect(onOpenWorkExplainer).toHaveBeenCalledWith("work_alpha", "artifacts/explainer.html");
    expect(listDocsSpy).toHaveBeenCalledWith({ repoId: "repo-1", taskId: "work_alpha" });
    expect(getDocSpy).toHaveBeenCalledWith({
      repoId: "repo-1",
      taskId: "work_alpha",
      path: "artifacts/explainer.html",
    });
    expect(document.querySelector("[data-testid='work-explainer-document']")).not.toBeNull();
    expect(document.querySelector("[data-testid='dossier-work-explainer-title']")?.textContent).toBe(
      "Alpha Platform Work",
    );

    await act(async () => {
      document
        .querySelector("[data-testid='dossier-open-work-workspace']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenWork).toHaveBeenCalledWith("work_alpha");

    await act(async () => {
      document
        .querySelector("[data-testid='dossier-back-from-work-explainer']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);
    expect(document.querySelector("[data-testid='dossier-html-frame']")).not.toBeNull();
  });
});

describe("refreshDossierSlot concurrent watermark alignment (F-DOSSIER-01)", () => {
  it("re-reads latest body when another writer advances r64->r128 between initial read and page 1 context", async () => {
    const bodyAt64 = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: contextSlot,
      previousBody: null,
      expectedWatermark: 0,
      targetWatermark: 64,
      changes: [
        {
          eventId: "evt_r64",
          schema: "task-event/v1",
          type: "task_completed",
          occurredAt: "2026-11-22T08:00:00.000Z",
          workspaceRevision: 64,
          taskId: "task_r64",
          actor: { executor: { id: "worker" } },
          payload: { title: "Window 1..64 deliverable" },
          entityRefs: ["task/task_r64"],
        },
      ],
      synthesizedAt: "2026-11-22T08:00:00.000Z",
    });
    const bodyAt128 = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: contextSlot,
      previousBody: bodyAt64,
      expectedWatermark: 64,
      targetWatermark: 128,
      changes: [
        {
          eventId: "evt_r128",
          schema: "decision-event/v1",
          type: "decision_accepted",
          occurredAt: "2026-11-22T09:00:00.000Z",
          workspaceRevision: 100,
          decisionId: "dec_r100",
          actor: { principal: { personId: "person_zeyu" } },
          payload: { title: "Concurrent writer r65-r128 decision" },
          entityRefs: ["decision/dec_r100"],
        },
      ],
      synthesizedAt: "2026-11-22T09:00:00.000Z",
    });

    let serverWatermark = 64;
    let serverBody = bodyAt64;
    let readCalls = 0;

    const readSpy = vi.spyOn(dossierClient, "read").mockImplementation(async (): Promise<DossierContentRead> => {
      readCalls += 1;
      const result: DossierContentRead = {
        schema: "dossier-content/v1",
        slot: contextSlot,
        state: {
          verticalId: "software/coding",
          slotId: "context",
          lastSynthesizedWatermark: serverWatermark,
          synthesizedAt: "2026-11-22T09:00:00.000Z",
          path: contextSlot.documentPath,
        },
        mediaType: "text/markdown",
        body: serverBody,
      };
      // Right after GUI's initial read(r64), a concurrent writer commits r128!
      if (readCalls === 1) {
        serverWatermark = 128;
        serverBody = bodyAt128;
      }
      return result;
    });

    const contextSpy = vi.spyOn(dossierClient, "context").mockImplementation(
      async (): Promise<DossierContextRead> => ({
        schema: "dossier-context/v1",
        slotId: "context",
        expectedWatermark: serverWatermark,
        currentWatermark: 192,
        nextWatermark: 192,
        done: true,
        kindMap: {},
        changes: [
          {
            eventId: "evt_r192",
            schema: "task-event/v1",
            type: "task_completed",
            occurredAt: "2026-11-22T10:00:00.000Z",
            workspaceRevision: 180,
            source: "local",
            actor: { executor: { id: "worker" } },
            payload: { title: "Window 129..192 deliverable" },
            entityRefs: ["task/task_r192"],
            matchedKinds: ["task"],
          },
        ],
      }),
    );

    const synthSpy = vi.spyOn(dossierClient, "synthesize").mockImplementation(async (_repoId, payload) => {
      expect(payload.expectedWatermark).toBe(128);
      expect(payload.watermark).toBe(192);
      serverWatermark = payload.watermark;
      serverBody = payload.body;
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "dossier-synthesize",
        outcome: "applied",
        opId: "op_192",
      };
    });

    const outcome = await refreshDossierSlot({
      repoId: "repo-1",
      verticalId: "software/coding",
      slot: contextSlot,
      now: () => "2026-11-22T10:30:00.000Z",
    });

    expect(outcome).toEqual({
      ok: true,
      slotId: "context",
      pagesApplied: 1,
      reachedWatermark: 192,
      remaining: false,
    });
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(contextSpy).toHaveBeenCalledTimes(2);
    expect(synthSpy).toHaveBeenCalledTimes(1);
    expect(serverBody).toContain("Window 1..64 deliverable");
    expect(serverBody).toContain("Concurrent writer r65-r128 decision");
    expect(serverBody).toContain("Window 129..192 deliverable");
  });

  it("re-reads latest body when another writer advances r64->r128 between page 1 synthesize and page 2 context", async () => {
    let serverWatermark = 0;
    let serverBody: string | null = null;
    let injectedBetweenPages = false;

    const readSpy = vi.spyOn(dossierClient, "read").mockImplementation(
      async (): Promise<DossierContentRead> => ({
        schema: "dossier-content/v1",
        slot: contextSlot,
        state:
          serverWatermark > 0
            ? {
                verticalId: "software/coding",
                slotId: "context",
                lastSynthesizedWatermark: serverWatermark,
                synthesizedAt: "2026-11-22T09:00:00.000Z",
                path: contextSlot.documentPath,
              }
            : null,
        mediaType: "text/markdown",
        body: serverBody,
      }),
    );

    const contextSpy = vi.spyOn(dossierClient, "context").mockImplementation(async (): Promise<DossierContextRead> => {
      if (serverWatermark === 0) {
        return {
          schema: "dossier-context/v1",
          slotId: "context",
          expectedWatermark: 0,
          currentWatermark: 192,
          nextWatermark: 64,
          done: false,
          kindMap: {},
          changes: [
            {
              eventId: "evt_p1_r40",
              schema: "task-event/v1",
              type: "task_completed",
              occurredAt: "2026-11-22T08:00:00.000Z",
              workspaceRevision: 40,
              source: "local",
              actor: { executor: { id: "worker" } },
              payload: { title: "Page 1 r1..r64 work" },
              entityRefs: ["task/task_p1"],
              matchedKinds: ["task"],
            },
          ],
        };
      }
      // Concurrent writer jumps r64 -> r128 before GUI's page 2 context call!
      if (serverWatermark === 64 && !injectedBetweenPages) {
        injectedBetweenPages = true;
        serverBody = synthesizeDossierDocument({
          verticalId: "software/coding",
          slot: contextSlot,
          previousBody: serverBody,
          expectedWatermark: 64,
          targetWatermark: 128,
          changes: [
            {
              eventId: "evt_mid_r100",
              schema: "decision-event/v1",
              type: "decision_accepted",
              occurredAt: "2026-11-22T09:00:00.000Z",
              workspaceRevision: 100,
              decisionId: "dec_mid_r100",
              actor: { principal: { personId: "person_zeyu" } },
              payload: { title: "Interleaved r65..r128 chronicler decision" },
              entityRefs: ["decision/dec_mid_r100"],
            },
          ],
          synthesizedAt: "2026-11-22T09:00:00.000Z",
        });
        serverWatermark = 128;
      }
      return {
        schema: "dossier-context/v1",
        slotId: "context",
        expectedWatermark: serverWatermark,
        currentWatermark: 192,
        nextWatermark: 192,
        done: true,
        kindMap: {},
        changes: [
          {
            eventId: "evt_p3_r180",
            schema: "task-event/v1",
            type: "task_completed",
            occurredAt: "2026-11-22T10:00:00.000Z",
            workspaceRevision: 180,
            source: "local",
            actor: { executor: { id: "worker" } },
            payload: { title: "Page 3 r129..r192 work" },
            entityRefs: ["task/task_p3"],
            matchedKinds: ["task"],
          },
        ],
      };
    });

    const synthSpy = vi.spyOn(dossierClient, "synthesize").mockImplementation(async (_repoId, payload) => {
      serverWatermark = payload.watermark;
      serverBody = payload.body;
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "dossier-synthesize",
        outcome: "applied",
        opId: `op_${payload.watermark}`,
      };
    });

    const outcome = await refreshDossierSlot({
      repoId: "repo-1",
      verticalId: "software/coding",
      slot: contextSlot,
      now: () => "2026-11-22T10:30:00.000Z",
    });

    expect(outcome).toEqual({
      ok: true,
      slotId: "context",
      pagesApplied: 2,
      reachedWatermark: 192,
      remaining: false,
    });
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(contextSpy).toHaveBeenCalledTimes(3);
    expect(synthSpy).toHaveBeenCalledTimes(2);
    expect(synthSpy.mock.calls[0]?.[1]).toMatchObject({ expectedWatermark: 0, watermark: 64 });
    expect(synthSpy.mock.calls[1]?.[1]).toMatchObject({ expectedWatermark: 128, watermark: 192 });
    expect(serverBody).toContain("Page 1 r1..r64 work");
    expect(serverBody).toContain("Interleaved r65..r128 chronicler decision");
    expect(serverBody).toContain("Page 3 r129..r192 work");
  });

  it("returns dossier_watermark_conflict without submitting stale body if concurrent drift exceeds retry ceiling", async () => {
    let serverWatermark = 10;
    vi.spyOn(dossierClient, "read").mockImplementation(
      async (): Promise<DossierContentRead> => ({
        schema: "dossier-content/v1",
        slot: contextSlot,
        state: {
          verticalId: "software/coding",
          slotId: "context",
          lastSynthesizedWatermark: serverWatermark,
          synthesizedAt: "2026-11-22T09:00:00.000Z",
          path: contextSlot.documentPath,
        },
        mediaType: "text/markdown",
        body: sampleMarkdown,
      }),
    );
    vi.spyOn(dossierClient, "context").mockImplementation(async (): Promise<DossierContextRead> => {
      // Every context call sees a newer watermark than what read() just returned
      serverWatermark += 10;
      return {
        schema: "dossier-context/v1",
        slotId: "context",
        expectedWatermark: serverWatermark,
        currentWatermark: 200,
        nextWatermark: serverWatermark + 10,
        done: false,
        kindMap: {},
        changes: [],
      };
    });
    const synthSpy = vi.spyOn(dossierClient, "synthesize");

    const outcome = await refreshDossierSlot({
      repoId: "repo-1",
      verticalId: "software/coding",
      slot: contextSlot,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.conflict).toBe(true);
      expect(outcome.code).toBe("dossier_watermark_conflict");
    }
    expect(synthSpy).not.toHaveBeenCalled();
  });

  it("preserves chronicler-authored Markdown verbatim when GUI advances an empty incremental page (F-DOSSIER-02)", async () => {
    const chroniclerBody = [
      "<!-- dossier-watermark: 10 -->",
      "# Domain Context",
      "",
      "<!-- dossier-anchor: overview -->",
      "## Overview",
      "Curated narrative authored by chronicler without private dossier-state comments.",
      "",
      "<!-- dossier-anchor: active-invariants -->",
      "## Active Invariants",
      "Single-writer canonical ledger enforces linear watermark fences.",
      "",
      "<!-- dossier-anchor: recent-changes -->",
      "## Recent Changes",
      "Baseline curated at r10.",
      "",
    ].join("\n");

    vi.spyOn(dossierClient, "read").mockResolvedValue({
      schema: "dossier-content/v1",
      slot: contextSlot,
      state: {
        verticalId: "software/coding",
        slotId: "context",
        lastSynthesizedWatermark: 10,
        synthesizedAt: "2026-11-22T09:00:00.000Z",
        path: contextSlot.documentPath,
      },
      mediaType: "text/markdown",
      body: chroniclerBody,
    });
    vi.spyOn(dossierClient, "context").mockResolvedValue({
      schema: "dossier-context/v1",
      slotId: "context",
      expectedWatermark: 10,
      currentWatermark: 16,
      nextWatermark: 16,
      done: true,
      kindMap: {},
      changes: [],
    });
    let submittedBody = "";
    const synthSpy = vi.spyOn(dossierClient, "synthesize").mockImplementation(async (_repoId, payload) => {
      submittedBody = payload.body;
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "dossier-synthesize",
        outcome: "applied",
        opId: "op_16",
      };
    });

    const outcome = await refreshDossierSlot({
      repoId: "repo-1",
      verticalId: "software/coding",
      slot: contextSlot,
      now: () => "2026-11-22T10:30:00.000Z",
    });

    expect(outcome).toEqual({
      ok: true,
      slotId: "context",
      pagesApplied: 1,
      reachedWatermark: 16,
      remaining: false,
    });
    expect(synthSpy).toHaveBeenCalledTimes(1);
    expect(submittedBody.split("\n", 1)[0]).toBe("<!-- dossier-watermark: 16 -->");
    expect(submittedBody.slice(submittedBody.indexOf("\n"))).toBe(chroniclerBody.slice(chroniclerBody.indexOf("\n")));
    expect(submittedBody).not.toContain("<!-- dossier-state:v1 ");
  });
});
