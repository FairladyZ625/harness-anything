import { describe, expect, it } from "vitest";
import {
  isRepoSelectable,
  projectFromDaemonRepo,
  projectsFromDaemonRepos,
  resolveActiveRepoId,
  repoDisplayName,
  repoStateI18nKey,
} from "../src/renderer/model/project-repos.ts";
import {
  DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
  DAEMON_STATUS_STALE_UNAVAILABLE_RAW,
} from "../src/renderer/model/daemon-status-fixture.ts";
import { extractRepoScopedPayload, jsonRpcParamsForGuiRoute } from "../src/main/local-composition-root.ts";
import type { ApiRouteContract } from "../src/api/api-contract-registry.ts";
import { stripRepoRoutingField, validateGuiRoutePayload } from "../src/api/gui-route-payload.ts";
import { adaptProjectionRows } from "../src/renderer/task-adapter.ts";
import type { TaskProjectionRow } from "../src/api/renderer-dto.ts";

const healthy = DAEMON_STATUS_HEALTHY_TWO_REPO_RAW;
const stale = DAEMON_STATUS_STALE_UNAVAILABLE_RAW;

describe("projectsFromDaemonRepos", () => {
  it("builds switcher list from daemon-status repos[] (not mock projects)", () => {
    const projects = projectsFromDaemonRepos(healthy.repos, {
      preset: "software/coding",
      engines: ["local"],
      watermarkAt: "2026-07-16T00:00:00.000Z",
    });
    expect(projects.map((p) => p.id)).toEqual(["canonical", "experiment"]);
    expect(projects[0]).toMatchObject({
      id: "canonical",
      name: "Canonical",
      path: "/work/canonical",
      repoState: "attached",
      lockPath: ".harness/journal/global.lock",
    });
    expect(projects[1].name).toBe("Experiment");
  });

  it("surfaces unavailable state and lock/error honestly", () => {
    const projects = projectsFromDaemonRepos(stale.repos);
    const experiment = projects.find((p) => p.id === "experiment");
    expect(experiment?.repoState).toBe("unavailable");
    expect(experiment?.lockPath).toBeNull();
    expect(experiment?.lastError).toMatch(/global lock already held/);
    expect(isRepoSelectable(stale.repos[1]!)).toBe(false);
    expect(isRepoSelectable(stale.repos[0]!)).toBe(true);
  });
});

describe("resolveActiveRepoId", () => {
  it("keeps explicit selection when still registered", () => {
    expect(resolveActiveRepoId(healthy.repos, "experiment", "canonical")).toBe("experiment");
  });

  it("falls back to requestedRepo then first attached", () => {
    expect(resolveActiveRepoId(healthy.repos, "ghost", "canonical")).toBe("canonical");
    expect(resolveActiveRepoId(healthy.repos, null, null)).toBe("canonical");
  });

  it("single-repo list resolves to that repo (regression)", () => {
    const single = [healthy.repos[0]!];
    expect(resolveActiveRepoId(single, null, "canonical")).toBe("canonical");
    expect(resolveActiveRepoId(single, "canonical", "canonical")).toBe("canonical");
  });
});

describe("repo display helpers", () => {
  it("prefers displayName then repoId", () => {
    expect(repoDisplayName(healthy.repos[0]!)).toBe("Canonical");
    expect(
      repoDisplayName({ ...healthy.repos[0]!, displayName: undefined })
    ).toBe("canonical");
  });

  it("maps state to i18n keys", () => {
    expect(repoStateI18nKey("attached")).toBe("components.appSidebar.repoStateAttached");
    expect(repoStateI18nKey("unavailable")).toBe("components.appSidebar.repoStateUnavailable");
    expect(repoStateI18nKey(undefined)).toBe("components.appSidebar.repoStateUnknown");
  });
});

describe("extractRepoScopedPayload / jsonRpcParamsForGuiRoute", () => {
  const emptyRoute = {
    id: "tasks.list",
    method: "GET",
    path: "/api/tasks",
    inputSchemaId: "gui.empty/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTasks",
    auth: "local-session-token",
    guiBridgeMethod: "getTasks",
    commandClass: "repo-read",
  } as ApiRouteContract;

  const taskRoute = {
    id: "tasks.detail",
    method: "GET",
    path: "/api/tasks/:taskId",
    inputSchemaId: "application.task-id-payload/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTaskDetail",
    auth: "local-session-token",
    guiBridgeMethod: "getTaskDetail",
    commandClass: "repo-read",
  } as ApiRouteContract;

  it("routes explicit repoId from bridge payload and strips it from service payload", () => {
    const extracted = extractRepoScopedPayload({ repoId: "experiment" }, "canonical");
    expect(extracted.repoId).toBe("experiment");
    expect(extracted.servicePayload).toBeUndefined();

    const params = jsonRpcParamsForGuiRoute(emptyRoute, "canonical", { repoId: "experiment" });
    expect(params).toEqual({ repo: { repoId: "experiment" } });
  });

  it("falls back to composition-root target when payload has no repoId (single-repo)", () => {
    const params = jsonRpcParamsForGuiRoute(emptyRoute, "canonical", null);
    expect(params).toEqual({ repo: { repoId: "canonical" } });
  });

  it("keeps service fields while promoting repoId", () => {
    const params = jsonRpcParamsForGuiRoute(taskRoute, "canonical", {
      taskId: "task-1",
      repoId: "experiment",
    });
    expect(params).toEqual({
      repo: { repoId: "experiment" },
      payload: { taskId: "task-1" },
    });
  });

  it("validateGuiRoutePayload ignores renderer repoId on empty routes", () => {
    const stripped = stripRepoRoutingField({ repoId: "experiment" });
    expect(stripped).toBeNull();
    const validation = validateGuiRoutePayload(emptyRoute, { repoId: "experiment" });
    expect(validation.ok).toBe(true);
  });

  it("validateGuiRoutePayload still requires taskId after strip", () => {
    const ok = validateGuiRoutePayload(taskRoute, { taskId: "task-1", repoId: "experiment" });
    expect(ok.ok).toBe(true);
    const bad = validateGuiRoutePayload(taskRoute, { repoId: "experiment" });
    expect(bad.ok).toBe(false);
  });
});

describe("adaptProjectionRows projectId binding", () => {
  it("tags rows with the active repoId so switcher filters match", () => {
    const row = {
      schema: "sqlite-task-row/v1",
      taskId: "task-x",
      title: "X",
      canonicalStatus: "planned",
      coordinationStatus: "open",
      rawStatus: "planned",
      packageDisposition: "active",
      closeoutReadiness: "not-ready",
      lifecycleEngine: "local",
      freshness: "fresh",
      updatedAt: "2026-07-09T00:00:00.000Z",
      source: "local-document",
      sourcePath: "harness/tasks/task-x/INDEX.md",
      attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    } as TaskProjectionRow;
    const adapted = adaptProjectionRows([row], "experiment");
    expect(adapted[0]?.projectId).toBe("experiment");
  });
});

describe("projectFromDaemonRepo", () => {
  it("uses repoId as Project.id (selected project === selected repoId)", () => {
    const project = projectFromDaemonRepo(healthy.repos[1]!);
    expect(project.id).toBe("experiment");
    expect(project.repoState).toBe("attached");
  });
});
