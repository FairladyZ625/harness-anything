import { CaretUp, List, Plus, TerminalWindow, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.tsx";
import type { TerminalSessionInfo } from "../../terminal-api-client.ts";
import { TerminalPane } from "./TerminalPane.tsx";
import { TerminalSessionManager } from "./TerminalSessionManager.tsx";
import {
  activateTerminalTab,
  addTerminalTab,
  bindTabSession,
  createAttachTab,
  createSpawnTab,
  emptyTerminalTabState,
  removeTerminalTab,
  type TerminalTabState
} from "./terminal-tab-state.ts";

export interface TerminalDockProps {
  readonly open: boolean;
  readonly projectId: string;
  readonly onToggle: () => void;
}

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `term-tab-${tabSeq}-${Date.now().toString(36)}`;
}

export function TerminalDock({ open, projectId, onToggle }: TerminalDockProps) {
  const [tabState, setTabState] = useState<TerminalTabState>(() => emptyTerminalTabState());
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerRefresh, setManagerRefresh] = useState(0);
  // Keep tabs across project switches only if they match; otherwise reset.
  const lastProjectId = useRef(projectId);

  useEffect(() => {
    if (lastProjectId.current === projectId) return;
    lastProjectId.current = projectId;
    setTabState(emptyTerminalTabState());
    setManagerOpen(false);
  }, [projectId]);

  // When the dock first opens with no tabs, spawn a default session tab.
  useEffect(() => {
    if (!open) return;
    setTabState((prev) => {
      if (prev.tabs.length > 0) return prev;
      return addTerminalTab(
        prev,
        createSpawnTab(projectId, t("terminal.dock.title"), nextTabId())
      );
    });
  }, [open, projectId]);

  const spawnTab = useCallback(() => {
    setTabState((prev) =>
      addTerminalTab(prev, createSpawnTab(projectId, t("terminal.dock.newTab"), nextTabId()))
    );
    setManagerOpen(false);
  }, [projectId]);

  const attachTab = useCallback((session: TerminalSessionInfo) => {
    setTabState((prev) => addTerminalTab(prev, createAttachTab(projectId, session, nextTabId())));
    setManagerOpen(false);
  }, [projectId]);

  const closeTab = useCallback((tabId: string) => {
    // Removing the tab unmounts TerminalPane, which detaches (not terminates).
    setTabState((prev) => removeTerminalTab(prev, tabId));
    setManagerRefresh((value) => value + 1);
  }, []);

  return (
    <section
      className={`relative shrink-0 border-t border-border bg-surface ${
        open ? "flex h-80 min-h-48 flex-col" : "h-9"
      }`}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-xs font-medium text-text-muted hover:bg-surface-raised hover:text-text"
          aria-expanded={open}
          onClick={onToggle}
        >
          <TerminalWindow size={15} weight="bold" />
          <span>{t("terminal.dock.title")}</span>
          {!open && <CaretUp size={12} />}
        </button>

        {open && (
          <>
            <div className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
              {tabState.tabs.map((tab) => {
                const active = tab.tabId === tabState.activeTabId;
                return (
                  <div
                    key={tab.tabId}
                    className={`group flex h-7 max-w-[10rem] items-center gap-1 rounded-md px-2 text-[11px] ${
                      active
                        ? "bg-surface-raised text-text"
                        : "text-text-muted hover:bg-surface-raised/60 hover:text-text"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 truncate"
                      title={tab.title}
                      onClick={() => setTabState((prev) => activateTerminalTab(prev, tab.tabId))}
                    >
                      {tab.title}
                    </button>
                    <button
                      type="button"
                      className="grid size-4 place-items-center rounded text-text-faint opacity-0 group-hover:opacity-100 hover:bg-surface hover:text-text"
                      aria-label={t("terminal.dock.closeTab")}
                      title={t("terminal.dock.closeTab")}
                      onClick={() => closeTab(tab.tabId)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="grid size-7 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
                aria-label={t("terminal.dock.newTab")}
                title={t("terminal.dock.newTab")}
                onClick={spawnTab}
              >
                <Plus size={13} />
              </button>
            </div>

            <button
              type="button"
              className={`grid size-7 place-items-center rounded-md hover:bg-surface-raised hover:text-text ${
                managerOpen ? "bg-surface-raised text-text" : "text-text-faint"
              }`}
              aria-label={t("terminal.dock.sessions")}
              title={t("terminal.dock.sessions")}
              aria-pressed={managerOpen}
              onClick={() => setManagerOpen((value) => !value)}
            >
              <List size={14} />
            </button>

            <span className="font-mono text-[10px] text-text-faint">{t("terminal.dock.shortcut")}</span>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
              aria-label={t("terminal.dock.close")}
              title={t("terminal.dock.close")}
              onClick={onToggle}
            >
              <X size={14} />
            </button>
          </>
        )}

        {!open && (
          <span className="ml-auto font-mono text-[10px] text-text-faint">{t("terminal.dock.shortcut")}</span>
        )}
      </div>

      {open && managerOpen && (
        <TerminalSessionManager
          open={managerOpen}
          projectId={projectId}
          onClose={() => setManagerOpen(false)}
          onAttach={attachTab}
          onSpawn={spawnTab}
          refreshEpoch={managerRefresh}
        />
      )}

      {open && tabState.tabs.length > 0 && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {tabState.tabs.map((tab) => {
            const active = tab.tabId === tabState.activeTabId;
            return (
              <div
                key={tab.tabId}
                className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                aria-hidden={!active}
              >
                <TerminalPane
                  projectId={tab.projectId}
                  attachSessionId={tab.attachSessionId}
                  title={tab.title}
                  onSessionReady={(session) => {
                    setTabState((prev) => bindTabSession(prev, tab.tabId, session));
                  }}
                  onSessionEnded={() => {
                    setManagerRefresh((value) => value + 1);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {open && tabState.tabs.length === 0 && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-[#1d1d20] text-[12px] text-white/50">
          <p>{t("terminal.dock.empty")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-white/15 px-2 py-1 text-[11px] text-white/70 hover:bg-white/5"
              onClick={spawnTab}
            >
              {t("terminal.dock.newTab")}
            </button>
            <button
              type="button"
              className="rounded border border-white/15 px-2 py-1 text-[11px] text-white/70 hover:bg-white/5"
              onClick={() => setManagerOpen(true)}
            >
              {t("terminal.dock.sessions")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
