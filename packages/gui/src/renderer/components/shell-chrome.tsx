import {
  FolderSimple,
  CheckCircle,
  Sun,
  Moon,
  Desktop,
} from "@phosphor-icons/react";
import type { SystemRepoRow } from "../api-client.ts";
import type { WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import { STATUS_META } from "./badges.tsx";
import { t } from "../i18n/index.tsx";
import { useTheme, type ThemeMode } from "../theme.tsx";

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
      title={`主题：${mode}（点击切换）`}
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
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick} title={label}
      className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[15px] leading-snug transition-colors duration-100 ${
        active
          ? "bg-surface-raised font-medium text-text"
          : "text-text-muted hover:bg-surface-raised/60 hover:text-text"
      }`}
    >
      <span className="shrink-0 text-base">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto shrink-0 rounded bg-accent px-1.5 font-mono text-[11px] font-semibold tabular-nums text-accent-fg">
          {badge}
        </span>
      )}
    </button>
  );
}

/** Side-bar numbers are rendered verbatim from the daemon workspace summary. */
export function TaskCensusSummary({ summary }: { summary: WorkspaceSummaryRead["tasks"] }) {
  return (
    <span data-testid="real-task-summary" className="block font-mono text-[11px] text-text-faint">
      {t("components.appSidebar.taskCensus", { totalCount: summary.total })}
      <span> · {STATUS_META.active.label} {summary.byStatus.active}</span>
      <span> · {STATUS_META.blocked.label} {summary.byStatus.blocked}</span>
      <span> · {STATUS_META.in_review.label} {summary.byStatus.in_review}</span>
    </span>
  );
}

export function ProjectSummary({
  repo,
  active,
  onOpen,
}: {
  repo: SystemRepoRow;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      disabled={repo.registrationState !== "enabled"}
      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors duration-100 ${
        active
          ? "border-accent/70 bg-accent/10"
          : repo.registrationState === "enabled" ? "border-border bg-surface hover:border-border-strong hover:bg-surface-raised" : "cursor-not-allowed border-border bg-surface opacity-60"
      }`}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-surface-raised text-text-muted">
        <FolderSimple weight="duotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-text">
          {repo.displayName}
        </span>
        <span className="block truncate font-mono text-[13px] text-text-faint">
          {repo.repoId} · {repo.registrationState} / {repo.cellState}
        </span>
        <span className="mt-1 flex flex-wrap gap-1.5 font-mono text-[12px] tabular-nums">
          <span className={repo.cellState === "attached" ? "text-status-done" : "text-status-blocked"}>{repo.cellState}</span>
          <span className="text-text-faint">queue {repo.queueDepth ?? "unknown"}</span>
          <span className="text-text-faint">lock {repo.lockState}</span>
        </span>
        {repo.cellState !== "attached" && <span className="mt-1 block text-[11px] text-status-blocked">{repo.unavailableReason ?? repo.lastError ?? "unknown / 未投影"}</span>}
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
