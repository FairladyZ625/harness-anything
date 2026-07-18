/**
 * Terminal tab state model — pure helpers for multi-tab dock management.
 * Tabs are local UI views attached (or attaching) to backend sessions.
 * Closing a tab detaches the view; it never terminates the backend session.
 */

import type { TerminalSessionInfo } from "../../terminal-api-client.ts";

export type TerminalTabKind = "spawn" | "attach";

export interface TerminalTab {
  readonly tabId: string;
  readonly kind: TerminalTabKind;
  readonly title: string;
  /** Present once the backend session is known (after create/attach). */
  readonly sessionId?: string;
  readonly projectId: string;
  /** When set, pane should attach this existing session instead of spawning. */
  readonly attachSessionId?: string;
}

export interface TerminalTabState {
  readonly tabs: ReadonlyArray<TerminalTab>;
  readonly activeTabId: string | null;
}

export function emptyTerminalTabState(): TerminalTabState {
  return { tabs: [], activeTabId: null };
}

export function createSpawnTab(projectId: string, title: string, tabId: string): TerminalTab {
  return {
    tabId,
    kind: "spawn",
    title,
    projectId
  };
}

export function createAttachTab(
  projectId: string,
  session: Pick<TerminalSessionInfo, "sessionId" | "name">,
  tabId: string
): TerminalTab {
  return {
    tabId,
    kind: "attach",
    title: session.name || session.sessionId,
    projectId,
    attachSessionId: session.sessionId,
    sessionId: session.sessionId
  };
}

export function addTerminalTab(state: TerminalTabState, tab: TerminalTab): TerminalTabState {
  // Reuse existing tab that already views the same session.
  if (tab.sessionId) {
    const existing = state.tabs.find((entry) => entry.sessionId === tab.sessionId);
    if (existing) {
      return { tabs: state.tabs, activeTabId: existing.tabId };
    }
  }
  if (tab.attachSessionId) {
    const existing = state.tabs.find(
      (entry) => entry.attachSessionId === tab.attachSessionId || entry.sessionId === tab.attachSessionId
    );
    if (existing) {
      return { tabs: state.tabs, activeTabId: existing.tabId };
    }
  }
  return {
    tabs: [...state.tabs, tab],
    activeTabId: tab.tabId
  };
}

export function removeTerminalTab(state: TerminalTabState, tabId: string): TerminalTabState {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);
  if (tabs.length === 0) return { tabs: [], activeTabId: null };
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  const next = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, activeTabId: next?.tabId ?? null };
}

export function activateTerminalTab(state: TerminalTabState, tabId: string): TerminalTabState {
  if (!state.tabs.some((tab) => tab.tabId === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

export function bindTabSession(
  state: TerminalTabState,
  tabId: string,
  session: Pick<TerminalSessionInfo, "sessionId" | "name">
): TerminalTabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.tabId !== tabId) return tab;
      return {
        ...tab,
        sessionId: session.sessionId,
        // Remount (e.g. dock closed then reopened) must re-attach, not spawn again.
        attachSessionId: session.sessionId,
        title: session.name || tab.title
      };
    })
  };
}

export function activeTerminalTab(state: TerminalTabState): TerminalTab | null {
  if (!state.activeTabId) return null;
  return state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null;
}
