import { Plus, CloudSlash } from "@phosphor-icons/react";
import type { Project, TaskRow, EventEntry } from "../model/types";
import { BOARD_COLUMNS } from "../model/types";
import { EngineBadge, STATUS_META } from "../components/badges";
import { t } from "../i18n/index.tsx";

const dateTime = (iso: string) => iso.slice(5, 16).replace("T", " ");

function StatusStrip({ tasks }: { tasks: TaskRow[] }) {
  const total = tasks.length;
  const segments = BOARD_COLUMNS.map(
    (s) => [s, tasks.filter((t) => t.coordinationStatus === s).length] as const,
  ).filter(([, n]) => n > 0);
  if (total === 0)
    return <div className="h-1.5 w-full rounded-full bg-surface-raised" />;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
      {segments.map(([s, n]) => (
        <div
          key={s}
          title={`${s} · ${n}`}
          style={{
            width: `${(n / total) * 100}%`,
            background: STATUS_META[s].color,
          }}
        />
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  tasks,
  events,
  current,
  onOpen,
}: {
  project: Project;
  tasks: TaskRow[];
  events: EventEntry[];
  current: boolean;
  onOpen: (id: string) => void;
}) {
  const ready = tasks.filter((t) => t.closeoutReadiness === "ready").length;
  const stale = tasks.filter((t) => t.freshness === "stale-but-usable").length;
  const unavailable = tasks.filter(
    (t) => t.freshness === "unavailable-no-cache",
  ).length;
  const lastActivity = [
    ...events.map((e) => e.at),
    ...tasks.map((t) => t.lastKnownAt),
  ].reduce<string | null>((max, x) => (max === null || x > max ? x : max), null);

  return (
    <button
      onClick={() => onOpen(project.id)}
      className={`flex flex-col gap-2 rounded-lg border bg-surface p-3 text-left hover:bg-surface-raised/40 ${
        current ? "border-border-strong" : "border-border hover:border-border-strong"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate font-mono text-[13px] font-semibold">
          {project.name}
        </span>
        {current && (
          <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-text-faint">
            {t("views.homeView.current")}</span>
        )}
      </div>
      <div className="truncate font-mono text-[11px] text-text-faint">
        {project.path}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded bg-surface-raised px-1.5 py-px font-mono text-[11px] text-text-muted">
          {project.preset}
        </span>
        {project.engines.map((e) => (
          <EngineBadge key={e} engine={e} locked={e !== "local"} />
        ))}
      </div>
      <StatusStrip tasks={tasks} />
      <div className="flex items-center gap-2.5">
        {ready > 0 && (
          <span className="rounded-md bg-accent px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent-fg">
            {t("views.homeView.readyArchiving")}{ready}
          </span>
        )}
        {stale > 0 && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-stale">
            <span
              className="size-1.5 rounded-full"
              style={{ background: "var(--color-stale)" }}
            />
            {stale}
          </span>
        )}
        {unavailable > 0 && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-danger">
            <span
              className="size-1.5 rounded-full"
              style={{ background: "var(--color-danger)" }}
            />
            {unavailable}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-text-faint">
          {tasks.length} {t("views.homeView.task")}</span>
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-text-faint">
        <span>{t("views.homeView.activities")}{lastActivity ? dateTime(lastActivity) : "—"}</span>
        <span>{t("views.homeView.projection")}{dateTime(project.watermarkAt)}</span>
      </div>
    </button>
  );
}

export function HomeView({
  projects,
  tasks,
  events,
  currentProjectId,
  onOpenProject,
}: {
  projects: Project[];
  tasks: TaskRow[];
  events: EventEntry[];
  currentProjectId: string;
  onOpenProject: (id: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="ui-title font-semibold">{t("views.homeView.project")}</h1>
          <span className="font-mono text-[11px] text-text-faint">
            {projects.length}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-text-faint">
          {t("views.homeView.eachProjectCountedIndependentlyDisplayedSideBy")}</p>
      </header>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 p-4">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            tasks={tasks.filter((t) => t.projectId === p.id)}
            events={events.filter((e) => e.projectId === p.id)}
            current={p.id === currentProjectId}
            onOpen={onOpenProject}
          />
        ))}
        <button
          disabled
          title={t("views.homeView.localMultiProjectRegistrationWillAvailableV2")}
          className="flex min-h-36 cursor-not-allowed flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-text-faint opacity-60"
        >
          <Plus weight="bold" className="text-lg" />
          <span className="text-xs">{t("views.homeView.addProjectV2")}</span>
        </button>
      </div>

      <div className="px-4 pb-4">
        <div className="pb-1.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">
          {t("views.homeView.remoteProject")}</div>
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
          <CloudSlash weight="duotone" className="text-xl text-text-faint" />
          <span className="text-xs text-text-muted">
            {t("views.homeView.signAccessProjectsOtherDevicesV2")}</span>
          <button
            disabled
            className="ml-auto cursor-not-allowed rounded-md border border-border px-2 py-1 text-xs text-text-faint opacity-60"
          >
            {t("views.homeView.learnAboutMultiEndSynchronization")}</button>
        </div>
      </div>
    </div>
  );
}
