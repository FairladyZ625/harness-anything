/** @slice-activation GUI workspace shell contract: exported for layout routing tests and package-level shell consumers. */
import { t } from "./i18n/core.ts";

export type WorkspacePerspective = "triage" | "review" | "operate";

export type WorkspacePaneKind =
  | "board"
  | "list"
  | "review"
  | "task"
  | "taskContext"
  | "doc"
  | "file"
  | "browser"
  | "terminal"
  | "sessionList"
  | "logs"
  | "adapterInspector"
  | "checker";

export type WorkspacePanePlacement = "tab" | "split" | "dock" | "floating" | "external";
export type WorkspacePaneViewState = "visible" | "detached" | "hidden";

export type OpenTarget =
  | { readonly kind: "task"; readonly taskId: string; readonly projectId?: string }
  | { readonly kind: "taskContext"; readonly taskId: string; readonly projectId: string; readonly perspective?: WorkspacePerspective }
  | { readonly kind: "doc"; readonly path: string; readonly anchor?: string; readonly projectId?: string; readonly taskId?: string }
  | { readonly kind: "file"; readonly path: string; readonly line?: number; readonly col?: number; readonly projectId?: string }
  | { readonly kind: "terminal"; readonly sessionId?: string; readonly hostProfileId?: string; readonly cwd?: string; readonly taskId?: string; readonly projectId?: string }
  | { readonly kind: "sessionList"; readonly hostProfileId?: string; readonly projectId?: string }
  | { readonly kind: "logs"; readonly projectId?: string; readonly taskId?: string; readonly stream?: string }
  | { readonly kind: "url"; readonly url: string; readonly projectId?: string };

export type OpenIntentSource = "terminal" | "doc" | "graph" | "list" | "board" | "review" | "palette" | "sessionList";

export interface OpenIntent {
  readonly target: OpenTarget;
  readonly source: OpenIntentSource;
  readonly disposition?: WorkspacePanePlacement;
}

export interface WorkspacePaneDescriptor {
  readonly id: string;
  readonly kind: WorkspacePaneKind;
  readonly title: string;
  readonly placement: WorkspacePanePlacement;
  readonly viewState: WorkspacePaneViewState;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly hostProfileId?: string;
  readonly terminalSessionId?: string;
  readonly source?: OpenIntent;
  readonly state?: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkspaceLayout {
  readonly schema: "workspace-layout/v1";
  readonly perspective: WorkspacePerspective;
  readonly panes: ReadonlyArray<WorkspacePaneDescriptor>;
  readonly activePaneId: string;
}

export type WorkspaceLayoutRestoreResult =
  | { readonly ok: true; readonly layout: WorkspaceLayout }
  | { readonly ok: false; readonly error: "invalid_json" | "invalid_layout"; readonly layout: WorkspaceLayout };

export function createDefaultWorkspaceLayout(perspective: WorkspacePerspective = "operate"): WorkspaceLayout {
  const panes = defaultPanesForPerspective(perspective);
  return {
    schema: "workspace-layout/v1",
    perspective,
    panes,
    activePaneId: panes[0]?.id ?? "pane-empty"
  };
}

export function routeOpenIntent(intent: OpenIntent): WorkspacePaneDescriptor {
  const placement = intent.disposition ?? defaultPlacementForTarget(intent.target);
  const target = intent.target;
  switch (target.kind) {
    case "task":
      return pane({
        id: `task-${stableSegment(target.taskId)}`,
        kind: "task",
        title: t("renderer.workspaceShell.taskValue", { taskId: target.taskId }),
        placement,
        projectId: target.projectId,
        taskId: target.taskId,
        source: intent
      });
    case "taskContext":
      return pane({
        id: `task-context-${stableSegment(target.taskId)}-${target.perspective ?? "operate"}`,
        kind: "taskContext",
        title: t("renderer.workspaceShell.contextValue", { taskId: target.taskId }),
        placement,
        projectId: target.projectId,
        taskId: target.taskId,
        source: intent,
        state: { perspective: target.perspective ?? "operate" }
      });
    case "doc":
      return pane({
        id: `doc-${stableSegment(target.path)}${target.anchor ? `-${stableSegment(target.anchor)}` : ""}`,
        kind: "doc",
        title: target.anchor ? `${target.path}#${target.anchor}` : target.path,
        placement,
        projectId: target.projectId,
        taskId: target.taskId,
        source: intent
      });
    case "file":
      return pane({
        id: `file-${stableSegment(target.path)}${target.line ? `-${target.line}` : ""}`,
        kind: "file",
        title: target.line ? `${target.path}:${target.line}` : target.path,
        placement,
        projectId: target.projectId,
        source: intent,
        state: compactState({ line: target.line, col: target.col })
      });
    case "terminal":
      return pane({
        id: `terminal-${stableSegment(target.sessionId ?? target.taskId ?? target.cwd ?? "new")}`,
        kind: "terminal",
        title: target.sessionId
          ? t("renderer.workspaceShell.terminalValue", { sessionId: target.sessionId })
          : t("renderer.workspaceShell.newTerminal"),
        placement,
        projectId: target.projectId,
        taskId: target.taskId,
        hostProfileId: target.hostProfileId,
        terminalSessionId: target.sessionId,
        source: intent,
        state: compactState({ cwd: target.cwd })
      });
    case "sessionList":
      return pane({
        id: `session-list-${stableSegment(target.hostProfileId ?? target.projectId ?? "all")}`,
        kind: "sessionList",
        title: t("renderer.workspaceShell.terminalSessions"),
        placement,
        projectId: target.projectId,
        hostProfileId: target.hostProfileId,
        source: intent
      });
    case "logs":
      return pane({
        id: `logs-${stableSegment(target.taskId ?? target.projectId ?? target.stream ?? "project")}`,
        kind: "logs",
        title: target.stream
          ? t("renderer.workspaceShell.logsValue", { stream: target.stream })
          : t("renderer.workspaceShell.logs"),
        placement,
        projectId: target.projectId,
        taskId: target.taskId,
        source: intent,
        state: compactState({ stream: target.stream })
      });
    case "url":
      return pane({
        id: `browser-placeholder-${stableSegment(target.url)}`,
        kind: "browser",
        title: t("renderer.workspaceShell.externalUrl"),
        placement: "external",
        projectId: target.projectId,
        source: intent,
        state: { url: target.url, trustPolicy: "not-opened-by-p06" }
      });
  }
}

export function serializeWorkspaceLayout(layout: WorkspaceLayout): string {
  return JSON.stringify(layout);
}

export function restoreWorkspaceLayout(
  serialized: string,
  fallback: WorkspaceLayout = createDefaultWorkspaceLayout()
): WorkspaceLayoutRestoreResult {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!isWorkspaceLayout(parsed)) return { ok: false, error: "invalid_layout", layout: fallback };
    return { ok: true, layout: parsed };
  } catch {
    return { ok: false, error: "invalid_json", layout: fallback };
  }
}

export function resetWorkspaceLayout(perspective: WorkspacePerspective = "operate"): WorkspaceLayout {
  return createDefaultWorkspaceLayout(perspective);
}

export function detachPaneView(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  return {
    ...layout,
    panes: layout.panes.map((paneDescriptor) =>
      paneDescriptor.id === paneId ? { ...paneDescriptor, viewState: "detached" } : paneDescriptor
    )
  };
}

function defaultPanesForPerspective(perspective: WorkspacePerspective): ReadonlyArray<WorkspacePaneDescriptor> {
  const taskPane = routeOpenIntent({
    source: "board",
    target: { kind: "task", projectId: "project-local", taskId: "TASK-001" },
    disposition: perspective === "triage" ? "split" : "tab"
  });
  const docPane = routeOpenIntent({
    source: "doc",
    target: { kind: "doc", projectId: "project-local", taskId: "TASK-001", path: "task_plan.md" },
    disposition: "split"
  });
  const terminalPane = routeOpenIntent({
    source: "palette",
    target: {
      kind: "terminal",
      projectId: "project-local",
      taskId: "TASK-001",
      sessionId: "term-local-task",
      cwd: "."
    },
    disposition: "dock"
  });
  const logsPane = routeOpenIntent({
    source: "review",
    target: { kind: "logs", projectId: "project-local", taskId: "TASK-001", stream: "checks" },
    disposition: "dock"
  });

  if (perspective === "review") {
    return [
      pane({
        id: "review-queue-project-local",
        kind: "review",
        title: t("renderer.workspaceShell.reviewQueue"),
        placement: "tab",
        projectId: "project-local",
        state: { role: "queue" }
      }),
      routeOpenIntent({
        source: "review",
        target: { kind: "doc", projectId: "project-local", taskId: "TASK-001", path: "review-material.md" },
        disposition: "split"
      }),
      taskPane,
      logsPane,
      pane({
        id: "checker-project-local",
        kind: "checker",
        title: t("renderer.workspaceShell.reviewChecklist"),
        placement: "dock",
        projectId: "project-local",
        state: { role: "checklist" }
      }),
      terminalPane
    ];
  }
  if (perspective === "triage") {
    return [
      pane({
        id: "board-project-local",
        kind: "board",
        title: t("renderer.workspaceShell.triageBoard"),
        placement: "tab",
        projectId: "project-local",
        state: { role: "pressure" }
      }),
      pane({
        id: "list-project-local",
        kind: "list",
        title: t("renderer.workspaceShell.taskList"),
        placement: "split",
        projectId: "project-local",
        state: { role: "queue" }
      }),
      pane({
        id: "task-context-project-local",
        kind: "taskContext",
        title: t("renderer.workspaceShell.filtersAndTaskContext"),
        placement: "dock",
        projectId: "project-local",
        taskId: "TASK-001",
        state: { perspective, role: "filters" }
      }),
      taskPane,
      terminalPane,
      logsPane
    ];
  }
  return [taskPane, docPane, terminalPane, logsPane];
}

function defaultPlacementForTarget(target: OpenTarget): WorkspacePanePlacement {
  if (target.kind === "terminal" || target.kind === "logs") return "dock";
  if (target.kind === "url") return "external";
  if (target.kind === "doc" || target.kind === "file") return "split";
  return "tab";
}

function pane(input: Omit<WorkspacePaneDescriptor, "viewState"> & { readonly viewState?: WorkspacePaneViewState }): WorkspacePaneDescriptor {
  return stripUndefined({ ...input, viewState: input.viewState ?? "visible" }) as unknown as WorkspacePaneDescriptor;
}

function compactState(
  values: Readonly<Record<string, string | number | boolean | undefined>>
): Readonly<Record<string, string | number | boolean>> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined));
}

function stableSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 80) : "target";
}

function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (!isWorkspaceRecord(value)) return false;
  if (value.schema !== "workspace-layout/v1") return false;
  if (!isPerspective(value.perspective)) return false;
  if (typeof value.activePaneId !== "string") return false;
  if (!Array.isArray(value.panes) || value.panes.length === 0) return false;
  const ids = new Set<string>();
  for (const paneDescriptor of value.panes) {
    if (!isWorkspacePaneDescriptor(paneDescriptor)) return false;
    if (ids.has(paneDescriptor.id)) return false;
    ids.add(paneDescriptor.id);
  }
  return ids.has(value.activePaneId);
}

function isWorkspacePaneDescriptor(value: unknown): value is WorkspacePaneDescriptor {
  if (!isWorkspaceRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (!isPaneKind(value.kind)) return false;
  if (typeof value.title !== "string" || value.title.length === 0) return false;
  if (!isPanePlacement(value.placement)) return false;
  if (!isPaneViewState(value.viewState)) return false;
  if (value.projectId !== undefined && typeof value.projectId !== "string") return false;
  if (value.taskId !== undefined && typeof value.taskId !== "string") return false;
  if (value.hostProfileId !== undefined && typeof value.hostProfileId !== "string") return false;
  if (value.terminalSessionId !== undefined && typeof value.terminalSessionId !== "string") return false;
  if (value.source !== undefined && !isOpenIntent(value.source)) return false;
  if (value.state !== undefined && !isPaneState(value.state)) return false;
  if (value.kind === "browser" && !isP06BrowserPlaceholder(value)) return false;
  return true;
}

function isP06BrowserPlaceholder(value: Record<string, unknown>): boolean {
  if (value.placement !== "external") return false;
  if (!isWorkspaceRecord(value.state)) return false;
  if (value.state.trustPolicy !== "not-opened-by-p06") return false;
  if (typeof value.state.url !== "string" || value.state.url.length === 0) return false;
  if (value.source !== undefined) {
    if (!isOpenIntent(value.source)) return false;
    if (value.source.target.kind !== "url") return false;
  }
  return true;
}

function isWorkspaceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPerspective(value: unknown): value is WorkspacePerspective {
  return value === "triage" || value === "review" || value === "operate";
}

function isPaneKind(value: unknown): value is WorkspacePaneKind {
  return (
    value === "board" ||
    value === "list" ||
    value === "review" ||
    value === "task" ||
    value === "taskContext" ||
    value === "doc" ||
    value === "file" ||
    value === "browser" ||
    value === "terminal" ||
    value === "sessionList" ||
    value === "logs" ||
    value === "adapterInspector" ||
    value === "checker"
  );
}

function isPanePlacement(value: unknown): value is WorkspacePanePlacement {
  return value === "tab" || value === "split" || value === "dock" || value === "floating" || value === "external";
}

function isPaneViewState(value: unknown): value is WorkspacePaneViewState {
  return value === "visible" || value === "detached" || value === "hidden";
}

function isOpenIntent(value: unknown): value is OpenIntent {
  if (!isWorkspaceRecord(value)) return false;
  if (!isOpenIntentSource(value.source)) return false;
  if (!isOpenTarget(value.target)) return false;
  if (value.disposition !== undefined && !isPanePlacement(value.disposition)) return false;
  return true;
}

function isOpenIntentSource(value: unknown): value is OpenIntentSource {
  return (
    value === "terminal" ||
    value === "doc" ||
    value === "graph" ||
    value === "list" ||
    value === "board" ||
    value === "review" ||
    value === "palette" ||
    value === "sessionList"
  );
}

function isOpenTarget(value: unknown): value is OpenTarget {
  if (!isWorkspaceRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "task":
      return typeof value.taskId === "string" && optionalString(value.projectId);
    case "taskContext":
      return (
        typeof value.taskId === "string" &&
        typeof value.projectId === "string" &&
        (value.perspective === undefined || isPerspective(value.perspective))
      );
    case "doc":
      return (
        typeof value.path === "string" &&
        optionalString(value.anchor) &&
        optionalString(value.projectId) &&
        optionalString(value.taskId)
      );
    case "file":
      return typeof value.path === "string" && optionalNumber(value.line) && optionalNumber(value.col) && optionalString(value.projectId);
    case "terminal":
      return (
        optionalString(value.sessionId) &&
        optionalString(value.hostProfileId) &&
        optionalString(value.cwd) &&
        optionalString(value.taskId) &&
        optionalString(value.projectId)
      );
    case "sessionList":
      return optionalString(value.hostProfileId) && optionalString(value.projectId);
    case "logs":
      return optionalString(value.projectId) && optionalString(value.taskId) && optionalString(value.stream);
    case "url":
      return typeof value.url === "string" && value.url.length > 0 && optionalString(value.projectId);
    default:
      return false;
  }
}

function isPaneState(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  if (!isWorkspaceRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}
