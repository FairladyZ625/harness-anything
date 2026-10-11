import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, FolderSimple, PushPin, PushPinSlash, WarningCircle } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import { orderProjects } from "../../project-order-preferences.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";

const VIEWPORT_GUTTER = 8;

export interface QuickSwitcherPosition {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

export function quickSwitcherPosition(
  anchor: Pick<DOMRect, "bottom" | "left">,
  viewport: { readonly width: number; readonly height: number },
): QuickSwitcherPosition {
  const left = Math.max(VIEWPORT_GUTTER, Math.min(anchor.left, viewport.width - VIEWPORT_GUTTER));
  const top = Math.max(VIEWPORT_GUTTER, Math.min(anchor.bottom + VIEWPORT_GUTTER, viewport.height - VIEWPORT_GUTTER));
  return {
    left,
    top,
    maxHeight: Math.max(0, viewport.height - top - VIEWPORT_GUTTER),
  };
}

/** 非常态才说的行状态词(业主 2026-10-11:卡片只留项目名与一行状态;已附着不逐行重复)。 */
function stateWordKey(repo: SystemRepoRow): MessageKey | null {
  if (repo.registrationState !== "enabled") return "components.appSidebar.projectStateDisabled";
  switch (repo.cellState) {
    case "warming":
      return "components.appSidebar.projectStateWarming";
    case "unavailable":
      return "components.appSidebar.projectStateUnavailable";
    case "not_loaded":
      return "components.appSidebar.projectStateNotLoaded";
    default:
      return null;
  }
}

/** queue/lock 等诊断字段收进悬停详情(业主 2026-10-11),不再占卡片版面。 */
function diagnosticsTitle(repo: SystemRepoRow): string {
  const problem = [repo.unavailableReason, repo.lastError].filter((value): value is string => value !== null);
  return `${repo.repoId} · ${repo.registrationState} / ${repo.cellState} · queue ${repo.queueDepth ?? "unknown"} · lock ${repo.lockState}${
    problem.length ? ` · ${problem.join(" · ")}` : ""
  }`;
}

function ProjectRow({
  repo,
  active,
  pinned,
  onOpen,
  onTogglePin,
}: {
  readonly repo: SystemRepoRow;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly onOpen: () => void;
  readonly onTogglePin: () => void;
}) {
  const enabled = repo.registrationState === "enabled",
    stateKey = stateWordKey(repo);
  return (
    <div className="flex items-stretch gap-1">
      <button
        onClick={onOpen}
        disabled={!enabled}
        title={diagnosticsTitle(repo)}
        className={`flex min-w-0 flex-1 items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors duration-100 ${
          active
            ? "border-accent/70 bg-accent/10"
            : enabled
              ? "border-border bg-surface hover:border-border-strong hover:bg-surface-raised"
              : "cursor-not-allowed border-border bg-surface opacity-60"
        }`}
      >
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-surface-raised text-text-muted">
          <FolderSimple weight="duotone" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 break-words ui-prose font-semibold text-text">{repo.displayName}</span>
            {pinned ? <PushPin weight="fill" className="shrink-0 size-3 text-text-faint" aria-hidden /> : null}
          </span>
          <span className="block break-words font-mono ui-meta text-text-faint [overflow-wrap:anywhere]">
            {stateKey === null ? repo.repoId : `${repo.repoId} · ${t(stateKey)}`}
          </span>
        </span>
        {active && (
          <CheckCircle weight="fill" className="mt-0.5 shrink-0 ui-prose" style={{ color: "var(--color-accent)" }} />
        )}
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        data-testid={`quick-switcher-pin-${repo.repoId}`}
        aria-label={t(pinned ? "components.appSidebar.projectUnpinLabel" : "components.appSidebar.projectPinLabel", {
          name: repo.displayName || repo.repoId,
        })}
        title={t(pinned ? "components.appSidebar.projectUnpinLabel" : "components.appSidebar.projectPinLabel", {
          name: repo.displayName || repo.repoId,
        })}
        className="grid w-7 shrink-0 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
      >
        {pinned ? (
          <PushPinSlash weight="bold" className="size-3.5" aria-hidden />
        ) : (
          <PushPin weight="bold" className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}

export function QuickSwitcher({
  open,
  anchorRef,
  repos,
  activeRepoId,
  pinnedRepoIds,
  onToggleProjectPin,
  onOpenProject,
  onOpenProjectManager,
}: {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly pinnedRepoIds: ReadonlyArray<string>;
  readonly onToggleProjectPin: (repoId: string) => void;
  readonly onOpenProject: (repoId: string) => void;
  readonly onOpenProjectManager: () => void;
}) {
  const [position, setPosition] = useState<QuickSwitcherPosition | null>(null);
  const [disabledOpen, setDisabledOpen] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      setPosition(
        quickSwitcherPosition(anchor.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, open]);

  if (!open || position === null || typeof document === "undefined") return null;

  // 停用仓默认收进底部折叠区(业主 2026-10-11),不与常用项目混排;两组各自按
  // 置顶顺序稳定划分(置顶在前,其余保持 daemon 返回顺序)。
  const enabled = repos.filter((repo) => repo.registrationState === "enabled"),
    disabled = repos.filter((repo) => repo.registrationState !== "enabled");

  return createPortal(
    <div
      data-testid="quick-switcher-panel"
      className={`fixed z-40 flex w-max min-w-[min(320px,90vw)] max-w-[min(480px,90vw)] flex-col
        overflow-hidden rounded-lg border border-border-strong bg-surface-raised p-2 shadow-2xl shadow-black/35`}
      style={position}
    >
      <div className="flex shrink-0 items-center justify-between px-1 pb-2">
        <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
          {t("components.appSidebar.quickSwitch")}
        </span>
        <span className="font-mono ui-micro text-text-faint">
          {t("components.appSidebar.projectCount", { count: repos.length })}
        </span>
      </div>
      <div className="flex min-h-0 bounded-content flex-col gap-1.5 overflow-y-auto">
        {orderProjects(enabled, pinnedRepoIds).map((repo) => (
          <ProjectRow
            key={repo.repoId}
            repo={repo}
            active={repo.repoId === activeRepoId}
            pinned={pinnedRepoIds.includes(repo.repoId)}
            onOpen={() => onOpenProject(repo.repoId)}
            onTogglePin={() => onToggleProjectPin(repo.repoId)}
          />
        ))}
        {disabled.length > 0 ? (
          <div data-testid="quick-switcher-disabled" className="mt-1 border-t border-border pt-1.5">
            <button
              type="button"
              data-testid="quick-switcher-disabled-toggle"
              aria-expanded={disabledOpen}
              onClick={() => setDisabledOpen((isOpen) => !isOpen)}
              className="flex w-full items-center gap-1 px-1 pb-1 text-left font-mono ui-meta uppercase tracking-wide text-text-faint hover:text-text-muted"
            >
              <span aria-hidden>{disabledOpen ? "▾" : "▸"}</span>
              <span>{t("components.appSidebar.quickSwitchDisabledSection", { count: disabled.length })}</span>
            </button>
            {disabledOpen ? (
              <div className="flex flex-col gap-1.5">
                {orderProjects(disabled, pinnedRepoIds).map((repo) => (
                  <ProjectRow
                    key={repo.repoId}
                    repo={repo}
                    active={repo.repoId === activeRepoId}
                    pinned={pinnedRepoIds.includes(repo.repoId)}
                    onOpen={() => onOpenProject(repo.repoId)}
                    onTogglePin={() => onToggleProjectPin(repo.repoId)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-2 grid shrink-0 grid-cols-2 gap-1.5 border-t border-border pt-2">
        <button
          onClick={onOpenProjectManager}
          className={`rounded-md border border-border px-2 py-1.5 text-left ui-meta font-medium
            text-text-muted hover:border-border-strong hover:text-text`}
        >
          {t("components.appSidebar.manageAll")}
        </button>
        <button
          disabled
          className={`inline-flex items-center justify-center gap-1 rounded-md border border-border
            px-2 py-1.5 ui-meta text-text-faint opacity-70`}
        >
          <WarningCircle weight="bold" />
          {t("components.appSidebar.localMode")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
