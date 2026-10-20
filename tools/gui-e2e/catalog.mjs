import myDevices from "./scenarios/my-devices.mjs";
import runtimeHandoff from "./scenarios/runtime-handoff.mjs";
import agentRuntimeEffort from "./scenarios/agent-runtime-effort.mjs";
import agentSquadLifecycle from "./scenarios/agent-squad-lifecycle.mjs";
import providerProjectAccess from "./scenarios/provider-project-access.mjs";
import decisionsProvider from "./scenarios/decisions-provider.mjs";
import deviceLoginApproval from "./scenarios/device-login-approval.mjs";
import accountLogin from "./scenarios/account-login.mjs";
import taskAssignment from "./scenarios/task-assignment.mjs";
import accessOverview from "./scenarios/access-overview.mjs";
import permissionRequests from "./scenarios/permission-requests.mjs";
import workTeams from "./scenarios/work-teams.mjs";
import externalKeycloak from "./scenarios/external-keycloak.mjs";
import shellNavigation from "./scenarios/shell-navigation.mjs";
import navigationHistory from "./scenarios/navigation-history.mjs";
import projectSwitchRestore from "./scenarios/project-switch-restore.mjs";
import projectWindows from "./scenarios/project-windows.mjs";
import overview from "./scenarios/overview-first-usable.mjs";
import board from "./scenarios/board-preview-detail.mjs";
import taskTimelineRecordNavigation from "./scenarios/task-timeline-record-navigation.mjs";
import workProgressChain from "./scenarios/work-progress-chain.mjs";
import decisionSupersedeChain from "./scenarios/decision-supersede-chain.mjs";
import taskTerminal from "./scenarios/task-detail-open-terminal.mjs";
import terminalBasics from "./scenarios/terminal-basics.mjs";
import terminalPanes from "./scenarios/terminal-panes.mjs";
import terminalSidebar from "./scenarios/terminal-sidebar.mjs";
import terminalTaskTree from "./scenarios/terminal-task-tree.mjs";
import decisions from "./scenarios/decisions.mjs";
import decisionReviewResponses from "./scenarios/decision-review-responses.mjs";
import sessionsArtifacts from "./scenarios/sessions-artifacts.mjs";
import artifactsHtmlPreview from "./scenarios/artifacts-html-preview.mjs";
import artifactsRawPreview from "./scenarios/artifacts-raw-preview.mjs";
import artifactsSpreadsheetPreview from "./scenarios/artifacts-spreadsheet-preview.mjs";
import settings from "./scenarios/settings-appearance.mjs";
import edgeInvite from "./scenarios/edge-invite.mjs";
import declaredEntityKinds from "./scenarios/declared-entity-kinds.mjs";
import systemDaemonLogs from "./scenarios/system-daemon-logs.mjs";
import sessionsGrouping from "./scenarios/sessions-grouping.mjs";
import sessionsDeliveryStatus from "./scenarios/sessions-delivery-status.mjs";
import collaborationView from "./scenarios/collaboration-view.mjs";
import scheduleRunHistory from "./scenarios/schedule-run-history.mjs";
import daemonStartupWait from "./scenarios/daemon-startup-wait.mjs";
import cadenceView from "./scenarios/cadence-view.mjs";
import taskCloseoutLongValues from "./scenarios/task-closeout-long-values.mjs";
import taskReturnChoice from "./scenarios/task-return-choice.mjs";
import pageSplitLayout from "./scenarios/page-split-layout.mjs";
import overviewWipRegion from "./scenarios/overview-wip-region.mjs";
import overviewAttentionFocus from "./scenarios/overview-attention-focus.mjs";
import overviewArtifactsShelf from "./scenarios/overview-artifacts-shelf.mjs";
import overviewSplitBoard from "./scenarios/overview-split-board.mjs";
import taskDetailExplainerDefault from "./scenarios/task-detail-explainer-default.mjs";
import edgeReadFreshness from "./scenarios/edge-read-freshness.mjs";
import tokenUsageCosts from "./scenarios/token-usage-costs.mjs";
import graphSpotlightCards from "./scenarios/graph-spotlight-cards.mjs";
import previewDrawerSingle from "./scenarios/preview-drawer-single.mjs";
import overlayGlass from "./scenarios/overlay-glass.mjs";
import redesignMyAsks from "./scenarios/redesign-my-asks.mjs";
import redesignToday from "./scenarios/redesign-today.mjs";

export const catalog = [
  taskReturnChoice,
  myDevices,
  edgeReadFreshness,
  runtimeHandoff,
  agentRuntimeEffort,
  agentSquadLifecycle,
  providerProjectAccess,
  decisionsProvider,
  accountLogin,
  deviceLoginApproval,
  taskAssignment,
  workTeams,
  accessOverview,
  permissionRequests,
  externalKeycloak,
  shellNavigation,
  navigationHistory,
  previewDrawerSingle,
  overlayGlass,
  redesignMyAsks,
  projectSwitchRestore,
  projectWindows,
  overview,
  board,
  taskTerminal,
  terminalBasics,
  terminalPanes,
  terminalSidebar,
  terminalTaskTree,
  decisions,
  decisionReviewResponses,
  sessionsArtifacts,
  artifactsHtmlPreview,
  artifactsRawPreview,
  artifactsSpreadsheetPreview,
  settings,
  edgeInvite,
  declaredEntityKinds,
  systemDaemonLogs,
  sessionsGrouping,
  sessionsDeliveryStatus,
  collaborationView,
  scheduleRunHistory,
  daemonStartupWait,
  cadenceView,
  taskTimelineRecordNavigation,
  workProgressChain,
  decisionSupersedeChain,
  taskCloseoutLongValues,
  pageSplitLayout,
  overviewWipRegion,
  overviewAttentionFocus,
  overviewArtifactsShelf,
  overviewSplitBoard,
  taskDetailExplainerDefault,
  tokenUsageCosts,
  graphSpotlightCards,
  redesignToday,
];

export function selectScenarios({ lane, ids }) {
  return catalog.filter(
    (scenario) =>
      (!ids.length || ids.includes(scenario.id)) &&
      (lane === "all" || scenario.lane === "both" || scenario.lane === lane),
  );
}
