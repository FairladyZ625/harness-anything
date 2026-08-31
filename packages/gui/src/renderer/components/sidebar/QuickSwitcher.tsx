import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { WarningCircle } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { ProjectSummary } from "../shell-chrome.tsx";

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

export function QuickSwitcher({
  open,
  anchorRef,
  repos,
  activeRepoId,
  onOpenProject,
  onOpenProjectManager,
}: {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly onOpenProject: (repoId: string) => void;
  readonly onOpenProjectManager: () => void;
}) {
  const [position, setPosition] = useState<QuickSwitcherPosition | null>(null);

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

  return createPortal(
    <div
      data-testid="quick-switcher-panel"
      className={`fixed z-40 flex w-max min-w-[min(320px,90vw)] max-w-[min(480px,90vw)] flex-col
        overflow-hidden rounded-lg border border-border-strong bg-surface-raised p-2 shadow-2xl shadow-black/35`}
      style={position}
    >
      <div className="flex shrink-0 items-center justify-between px-1 pb-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("components.appSidebar.quickSwitch")}
        </span>
        <span className="font-mono text-[11px] text-text-faint">
          {t("components.appSidebar.projectCount", { count: repos.length })}
        </span>
      </div>
      <div className="flex min-h-0 max-h-[330px] flex-col gap-1.5 overflow-y-auto">
        {repos.map((repo) => (
          <ProjectSummary
            key={repo.repoId}
            repo={repo}
            active={repo.repoId === activeRepoId}
            onOpen={() => onOpenProject(repo.repoId)}
          />
        ))}
      </div>
      <div className="mt-2 grid shrink-0 grid-cols-2 gap-1.5 border-t border-border pt-2">
        <button
          onClick={onOpenProjectManager}
          className={`rounded-md border border-border px-2 py-1.5 text-left text-[12px] font-medium
            text-text-muted hover:border-border-strong hover:text-text`}
        >
          {t("components.appSidebar.manageAll")}
        </button>
        <button
          disabled
          className={`inline-flex items-center justify-center gap-1 rounded-md border border-border
            px-2 py-1.5 text-[12px] text-text-faint opacity-70`}
        >
          <WarningCircle weight="bold" />
          {t("components.appSidebar.localMode")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
