import {
  FolderSimple,
  CheckCircle,
  Sun,
  Moon,
  Desktop,
} from "@phosphor-icons/react";
import type { Project, TaskRow } from "../model/types.ts";
import { useTheme, type ThemeMode } from "../theme.tsx";
import { MockBadge } from "./MockBadge.tsx";
import { t } from "../i18n/index.tsx";

const THEME_CYCLE: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const THEME_ICON: Record<ThemeMode, React.ReactNode> = {
  dark: <Moon weight="duotone" />,
  light: <Sun weight="duotone" />,
  system: <Desktop weight="duotone" />,
};

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <button
      onClick={() => setMode(THEME_CYCLE[mode])}
      title={t("components.shellChrome.themeModeClickSwitch", { mode: mode })}
      className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
    >
      {THEME_ICON[mode]}
    </button>
  );
}

export function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
  isNew,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  isNew?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex min-w-fit items-center gap-2 rounded-md px-2.5 py-1.5 text-[15px] ${
        active
          ? "bg-surface-raised text-text"
          : "text-text-muted hover:bg-surface-raised/60 hover:text-text"
      }`}
    >
      <span className="text-base">{icon}</span>
      {label}
      {isNew && (
        <span className="rounded border border-accent px-1 font-mono text-[10px] leading-[1.4] text-accent">
          {t("components.shellChrome.new")}
        </span>
      )}
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto rounded bg-accent px-1.5 font-mono text-[11px] font-semibold text-accent-fg">
          {badge}
        </span>
      )}
    </button>
  );
}

export function ProjectSummary({
  project,
  active,
  onOpen,
  tasks,
}: {
  project: Project;
  active: boolean;
  onOpen: () => void;
  tasks: TaskRow[];
}) {
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const review = projectTasks.filter((t) => t.closeoutReadiness === "ready").length;
  const blocked = projectTasks.filter((t) => t.coordinationStatus === "blocked").length;
  const stale = projectTasks.filter((t) => t.freshness !== "fresh").length;

  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left ${
        active
          ? "border-accent/70 bg-accent/10"
          : "border-border bg-surface hover:border-border-strong hover:bg-surface-raised"
      }`}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-surface-raised text-text-muted">
        <FolderSimple weight="duotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-text">
          {project.name}
        </span>
        <span className="block truncate font-mono text-[13px] text-text-faint">
          {project.preset} · {t("components.shellChrome.taskCount", { count: projectTasks.length })}
        </span>
        <span className="mt-1 flex flex-wrap gap-1.5 font-mono text-[12px]">
          <span className="text-accent">{t("components.shellChrome.reviewCount", { count: review })}</span>
          <span className={blocked > 0 ? "text-status-blocked" : "text-text-faint"}>
            {t("components.shellChrome.blockedCount", { count: blocked })}
          </span>
          <span className={stale > 0 ? "text-stale" : "text-text-faint"}>
            {t("components.shellChrome.staleCount", { count: stale })}
          </span>
        </span>
      </span>
      {active && (
        <CheckCircle
          weight="fill"
          className="mt-0.5 shrink-0 text-[15px]"
          style={{ color: "var(--color-accent)" }}
        />
      )}
    </button>
  );
}

/** 挂在 mock 视图顶部的横幅,让操作者一眼分辨真假数据 */
export function MockViewBanner() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-stale/30 bg-stale/10 px-4 py-2">
      <MockBadge />
      <span className="font-mono text-[12px] text-text-muted">
        {t("components.shellChrome.demonstrationDataCurrentProjectHomepageStillContains")}</span>
    </div>
  );
}
