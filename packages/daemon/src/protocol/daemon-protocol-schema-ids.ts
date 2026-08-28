import { shape } from "./daemon-protocol-gui-types.ts";

export const DAEMON_TASK_SNAPSHOT_LIST_SCHEMA = Object.freeze({
  id: "daemon.task-snapshot-list/v1",
  required: Object.freeze(["ok", "status", "rows", "watermark", "sourceRevision", "warnings"]),
});

export const DAEMON_SETTINGS_READ_SCHEMA = Object.freeze({
  id: "daemon.settings-read/v1",
  required: Object.freeze(["schema", "ok", "settings"]),
});

export const DAEMON_CI_OBSERVATORY_SCHEMA = Object.freeze({
  id: "daemon.ci-observatory/v1",
});

export const DAEMON_OBSERVE_TAIL_SCHEMA = Object.freeze({
  id: "daemon.observe-tail/v3",
});

export const DAEMON_WORKSPACE_SUMMARY_SCHEMA = Object.freeze({
  id: "daemon.workspace-summary/v1",
  required: Object.freeze(["schema", "ok", "status", "tasks", "decisions", "watermark", "sourceRevision", "warnings"]),
});

export const DAEMON_AGENDA_SCHEMA = Object.freeze({
  id: "daemon.agenda/v1",
  required: Object.freeze([
    "schema",
    "ok",
    "command",
    "status",
    "inFlight",
    "awaitingDecision",
    "waitingOnOthers",
    "dispatchable",
    "page",
    "watermark",
    "sourceRevision",
    "warnings",
    "summary",
  ]),
});

export const DAEMON_RELATION_GRAPH_SCHEMA = Object.freeze({
    id: "daemon.relation-graph/v1",
    required: Object.freeze(["ok", "edges", "coverageRows", "factAnchors", "facts", "warnings"]),
  }),
  DAEMON_DECISION_LIST_SCHEMA = Object.freeze({
    id: "daemon.decision-list/v1",
    required: Object.freeze(["ok", "decisions", "warnings"]),
  }),
  DAEMON_DOCUMENT_READ_SCHEMA = Object.freeze({
    id: "daemon.document-read/v1",
    required: Object.freeze([
      "ok",
      "status",
      "taskId",
      "path",
      "body",
      "blobSha256",
      "worktreeBody",
      "uncommitted",
      "watermark",
      "sourceRevision",
    ]),
  }),
  DAEMON_TASK_DOCUMENT_LIST_SCHEMA = Object.freeze({
    id: "daemon.task-document-list/v1",
    required: Object.freeze(["ok", "status", "taskId", "documents", "watermark", "sourceRevision"]),
  }),
  DAEMON_PROTOCOL_ERROR_SCHEMA = Object.freeze({
    id: "daemon.protocol-error/v1",
    required: Object.freeze([
      "schema",
      "ok",
      "command",
      "outcome",
      "opId",
      "origin",
      "code",
      "evidence",
      "error",
      "nextAction",
    ]),
  }),
  DAEMON_GUI_COMMAND_RECEIPT_SCHEMA = Object.freeze({
    id: "command-receipt/v2",
  });

export const DAEMON_AGENT_RUNTIME_OVERVIEW_SCHEMA = Object.freeze({
    id: "daemon.agent-runtime-overview/v1",
  }),
  DAEMON_AGENT_RUNTIME_SESSION_GROUPS_SCHEMA = Object.freeze({
    id: "daemon.agent-runtime-session-groups/v1",
  }),
  DAEMON_AGENT_RUNTIME_SESSION_SCHEMA = Object.freeze({
    id: "daemon.agent-runtime-session/v1",
  }),
  DAEMON_AGENT_RUNTIME_EVENTS_SCHEMA = Object.freeze({
    id: "daemon.agent-runtime-events/v1",
  }),
  DAEMON_AGENT_RUNTIME_ATTACH_SCHEMA = Object.freeze({
    id: "daemon.agent-runtime-attach/v1",
  }),
  DAEMON_AGENT_RUNTIME_ATTACH_EVENT_SCHEMA = Object.freeze({
    id: "daemon.agent-runtime-attach-event/v1",
  }),
  DAEMON_TASK_DISPATCHES_SCHEMA = Object.freeze({
    id: "daemon.task-dispatches/v1",
  });

export const DAEMON_AGENT_ENTITY_CATALOG_SCHEMA = Object.freeze({
    id: "daemon.agent-entity-catalog/v1",
  }),
  DAEMON_AGENT_ENTITY_DETAIL_SCHEMA = Object.freeze({
    id: "daemon.agent-entity-detail/v1",
  }),
  DAEMON_AGENT_SKILL_CATALOG_SCHEMA = Object.freeze({
    id: "daemon.agent-skill-catalog/v1",
  }),
  DAEMON_SQUAD_ENTITY_CATALOG_SCHEMA = Object.freeze({
    id: "daemon.squad-entity-catalog/v1",
  }),
  DAEMON_SQUAD_ENTITY_DETAIL_SCHEMA = Object.freeze({
    id: "daemon.squad-entity-detail/v1",
  }),
  DAEMON_SQUAD_RUN_LIST_SCHEMA = Object.freeze({
    id: "daemon.squad-run-list/v1",
  }),
  DAEMON_SQUAD_RUN_READ_SCHEMA = Object.freeze({
    id: "daemon.squad-run-read/v1",
  }),
  DAEMON_SCHEDULES_LIST_SCHEMA = Object.freeze({
    id: "daemon.schedules-list/v1",
    required: Object.freeze([
      "ok",
      "status",
      "repoId",
      "repoMode",
      "viewerNodeId",
      "schedules",
      "watermark",
      "sourceRevision",
    ]),
  });

export const GUI_SYSTEM_STATUS_SCHEMA = Object.freeze({
    id: "gui-system-status/v1",
  }),
  DAEMON_CONTROL_RECEIPT_SCHEMA = Object.freeze({
    id: "daemon-control-receipt/v1",
  }),
  GUI_CATALOG_SNAPSHOT_SCHEMA = Object.freeze({
    id: "gui-catalog-snapshot/v1",
  }),
  GUI_CATALOG_PRESET_SCHEMA = Object.freeze({ id: "gui-catalog-preset/v1" }),
  CATALOG_REREAD_RECEIPT_SCHEMA = Object.freeze({
    id: "catalog-reread-receipt/v1",
  }),
  TERMINAL_SESSION_LIST_SCHEMA = Object.freeze({
    id: "terminal-session-list/v1",
  }),
  TERMINAL_CONTROL_RECEIPT_SCHEMA = Object.freeze({
    id: "terminal-control-receipt/v1",
  }),
  TERMINAL_INPUT_ACK_SCHEMA = Object.freeze({ id: "terminal-input-ack/v1" }),
  TERMINAL_DETACH_ACK_SCHEMA = Object.freeze({ id: "terminal-detach-ack/v1" }),
  TERMINAL_ATTACH_SCHEMA = Object.freeze({ id: "terminal-attach/v1" }),
  TERMINAL_ATTACH_EVENT_SCHEMA = Object.freeze({
    id: "terminal-attach-event/v1",
  });

export const daemonTaskQueryPayloadShape = shape({
  status: "string?",
  changedAfterRevision: "number?",
  updatedAfter: "string?",
  updatedBefore: "string?",
  limit: "number?",
  cursor: "string?",
});

export const daemonRelationQueryPayloadShape = shape({
  status: "string?",
  updatedAfter: "string?",
  updatedBefore: "string?",
  limit: "number?",
  cursor: "string?",
});

export const daemonAgendaPayloadShape = shape({
  limit: "number?",
  cursor: "string?",
});
