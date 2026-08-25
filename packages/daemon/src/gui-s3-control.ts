import { isJsonObject, rejectSecretKeys, type JsonObject } from "./protocol/json-rpc-types.ts";
import { isContractVersion } from "../../kernel/src/domain/contract-version.ts";

export interface DaemonControlReceipt extends JsonObject {
  readonly schema: "daemon-control-receipt/v1";
  readonly ok: boolean;
  readonly outcome: "pending" | "op_rejected" | "applied";
  readonly kind: "refresh" | "restart";
  readonly operationId: string;
  readonly phase: "queued" | "draining" | "starting" | "settled" | "failed";
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly before: JsonObject | null;
  readonly after: JsonObject | null;
  readonly error: JsonObject | null;
  readonly nextAction: string | null;
}
export interface CatalogRereadReceipt extends JsonObject {
  readonly schema: "catalog-reread-receipt/v1";
  readonly ok: boolean;
  readonly outcome: "applied" | "op_rejected";
  readonly operationId: string;
  readonly repoId: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly observedAt: string;
  readonly error: JsonObject | null;
}
export interface TerminalControlReceipt extends JsonObject {
  readonly schema: "terminal-control-receipt/v1";
  readonly ok: boolean;
  readonly outcome: "applied" | "op_rejected";
  readonly operationId: string;
  readonly sessionId: string | null;
  readonly daemonGeneration: number;
  readonly state: string;
  readonly error: JsonObject | null;
}
export interface TerminalSessionRow extends JsonObject {
  readonly sessionId: string;
  readonly repoId: string;
  readonly name: string;
  readonly cwd: string;
  readonly shellProfile: string;
  readonly requestedBackend: "direct-pty" | "tmux";
  readonly backend: "direct-pty" | "tmux";
  readonly status: "running" | "exited" | "unknown";
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly exitCode: number | null;
  readonly outputSeq: number;
  readonly durability: "daemon-process" | "daemon-restart";
  readonly warning: "tmux-unavailable" | null;
  readonly attachable: boolean;
}
export interface TerminalAttachSubscription {
  readonly initial: JsonObject;
  readonly next: () => Promise<JsonObject | null>;
  readonly detach: () => void;
}

export class GuiS3ContractError extends Error {
  readonly code = "invalid_result";
  constructor(message: string) {
    super(message);
    this.name = "GuiS3ContractError";
  }
}

type Rule =
  | "string"
  | "any-string"
  | "number"
  | "boolean"
  | "null-string"
  | "null-number"
  | "array"
  | "object"
  | "nullable-object";
const record = (value: unknown): value is JsonObject => isJsonObject(value);
function closed(value: unknown, fields: Readonly<Record<string, Rule>>, label: string): string[] {
  if (!record(value)) return [`${label} must be an object`];
  const errors: string[] = [];
  if (rejectSecretKeys(value).length) errors.push(`${label} contains a forbidden secret-like key`);
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) errors.push(`${label}.${key} is not allowed`);
  for (const [key, rule] of Object.entries(fields)) {
    const item = value[key];
    if (
      (rule === "null-string" && (item === null || typeof item === "string")) ||
      (rule === "null-number" && (item === null || typeof item === "number")) ||
      (rule === "nullable-object" && (item === null || record(item)))
    )
      continue;
    const expected =
      rule === "array"
        ? Array.isArray(item)
        : rule === "object"
          ? record(item)
          : rule === "any-string"
            ? typeof item === "string"
            : typeof item === rule;
    if (!expected || (rule === "string" && item === "")) errors.push(`${label}.${key} must be ${rule}`);
  }
  return errors;
}
const errorShape = (value: unknown, label: string): string[] =>
  value === null ? [] : closed(value, { code: "string", hint: "string" }, label);
const pointShape = (value: unknown, label: string): string[] =>
  value === null ? [] : closed(value, { daemonId: "string", pid: "number", startedAt: "string" }, label);
const digest = (value: unknown): boolean => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const integer = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

export function validateSystemStatus(value: unknown): readonly string[] {
  const errors = closed(
    value,
    { schema: "string", ok: "boolean", observedAt: "string", daemon: "object", repos: "array" },
    "system status",
  );
  if (!record(value)) return errors;
  if (value.schema !== "gui-system-status/v1") errors.push("system status schema is invalid");
  if (record(value.daemon)) {
    errors.push(
      ...closed(
        value.daemon,
        {
          daemonId: "string",
          pid: "number",
          protocolVersion: "object",
          startedAt: "string",
          uptimeMs: "number",
          endpoint: "string",
          build: "object",
          activeControl: "nullable-object",
        },
        "system status.daemon",
      ),
    );
    if (!isContractVersion(value.daemon.protocolVersion))
      errors.push("system status.daemon.protocolVersion is invalid");
    if (record(value.daemon.build))
      errors.push(
        ...closed(value.daemon.build, { version: "string", commitSha: "null-string" }, "system status.daemon.build"),
      );
    if (record(value.daemon.activeControl)) {
      errors.push(
        ...closed(
          value.daemon.activeControl,
          { kind: "string", operationId: "string", phase: "string", requestedAt: "string", error: "nullable-object" },
          "system status.daemon.activeControl",
        ),
        ...errorShape(value.daemon.activeControl.error, "system status.daemon.activeControl.error"),
      );
      if (
        !["refresh", "restart"].includes(String(value.daemon.activeControl.kind)) ||
        !["queued", "draining", "starting", "settled", "failed"].includes(String(value.daemon.activeControl.phase))
      )
        errors.push("system status active control enum is invalid");
    }
  }
  for (const [index, repo] of (Array.isArray(value.repos) ? value.repos : []).entries()) {
    errors.push(
      ...closed(
        repo,
        {
          repoId: "string",
          displayName: "string",
          canonicalRoot: "string",
          authoredBranch: "string",
          registrationState: "string",
          cellState: "string",
          generation: "null-number",
          queueDepth: "null-number",
          lockState: "string",
          recoveryMs: "null-number",
          lastError: "null-string",
          unavailableReason: "null-string",
        },
        `system status.repos[${index}]`,
      ),
    );
    if (
      record(repo) &&
      (!["enabled", "disabled"].includes(String(repo.registrationState)) ||
        !["warming", "attached", "unavailable", "not_loaded"].includes(String(repo.cellState)) ||
        !["held", "not_applicable", "unknown"].includes(String(repo.lockState)))
    )
      errors.push("system status repo enum is invalid");
  }
  return errors;
}
export function validateDaemonControlReceipt(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      outcome: "string",
      kind: "string",
      operationId: "string",
      phase: "string",
      requestedAt: "string",
      completedAt: "null-string",
      before: "nullable-object",
      after: "nullable-object",
      error: "nullable-object",
      nextAction: "null-string",
    },
    "daemon control receipt",
  );
  if (!record(value)) return errors;
  errors.push(
    ...pointShape(value.before, "receipt.before"),
    ...pointShape(value.after, "receipt.after"),
    ...errorShape(value.error, "receipt.error"),
  );
  if (
    value.schema !== "daemon-control-receipt/v1" ||
    !["pending", "op_rejected"].includes(String(value.outcome)) ||
    !["refresh", "restart"].includes(String(value.kind)) ||
    !["queued", "draining", "starting", "settled", "failed"].includes(String(value.phase))
  )
    errors.push("daemon control receipt enum is invalid");
  return errors;
}

export function validateCatalogSnapshot(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      status: "string",
      repoId: "string",
      observedAt: "string",
      catalogDigest: "string",
      defaults: "object",
      presets: "array",
      verticals: "array",
      templates: "array",
      adapters: "array",
    },
    "catalog snapshot",
  );
  if (!record(value)) return errors;
  if (
    value.schema !== "gui-catalog-snapshot/v1" ||
    !["ready", "pending"].includes(String(value.status)) ||
    !digest(value.catalogDigest)
  )
    errors.push("catalog snapshot identity is invalid");
  if (record(value.defaults))
    errors.push(
      ...closed(
        value.defaults,
        { verticalId: "string", presetId: "string", profileId: "null-string", locale: "string" },
        "catalog defaults",
      ),
    );
  for (const row of Array.isArray(value.presets) ? value.presets : []) {
    errors.push(
      ...closed(
        row,
        {
          id: "string",
          title: "string",
          description: "string",
          verticalId: "string",
          sourceKind: "string",
          validity: "string",
          version: "null-string",
          kind: "null-string",
          defaultProfile: "null-string",
          entrypoints: "array",
          issues: "array",
          shadows: "nullable-object",
        },
        "catalog preset",
      ),
    );
    if (
      record(row) &&
      (!["bundled", "user", "user-shadow"].includes(String(row.sourceKind)) ||
        !["valid", "unavailable", "blocked"].includes(String(row.validity)) ||
        !stringArray(row.entrypoints))
    )
      errors.push("catalog preset enum is invalid");
    if (record(row) && record(row.shadows)) {
      errors.push(...closed(row.shadows, { layer: "string", title: "string" }, "catalog preset shadows"));
      if (row.shadows.layer !== "bundled") errors.push("catalog preset shadow layer is invalid");
    }
  }
  for (const row of Array.isArray(value.verticals) ? value.verticals : []) {
    errors.push(
      ...closed(
        row,
        {
          id: "string",
          title: "string",
          version: "string",
          source: "string",
          available: "boolean",
          valid: "boolean",
          issues: "array",
        },
        "catalog vertical",
      ),
    );
    if (record(row) && row.source !== "builtin") errors.push("catalog vertical source is invalid");
  }
  for (const row of Array.isArray(value.templates) ? value.templates : []) {
    errors.push(
      ...closed(
        row,
        { templateRef: "string", slot: "string", materializeAs: "string", locales: "array" },
        "catalog template",
      ),
    );
    if (record(row) && !stringArray(row.locales)) errors.push("catalog template locales are invalid");
  }
  for (const row of Array.isArray(value.adapters) ? value.adapters : []) {
    errors.push(
      ...closed(
        row,
        {
          adapterId: "string",
          registered: "boolean",
          capabilities: "array",
          writability: "string",
          defaultProvider: "boolean",
          unavailableReason: "null-string",
        },
        "catalog adapter",
      ),
    );
    if (
      record(row) &&
      (row.registered !== true ||
        !stringArray(row.capabilities) ||
        !["read-only", "read-write", "unknown"].includes(String(row.writability)))
    )
      errors.push("catalog adapter state is invalid");
  }
  return errors;
}
export function validateCatalogPreset(value: unknown): readonly string[] {
  const errors = closed(
    value,
    { schema: "string", ok: "boolean", repoId: "string", preset: "object", resolved: "object" },
    "catalog preset detail",
  );
  if (!record(value)) return errors;
  if (value.schema !== "gui-catalog-preset/v1") errors.push("catalog preset detail schema is invalid");
  if (record(value.preset))
    errors.push(
      ...closed(
        value.preset,
        {
          id: "string",
          title: "string",
          verticalId: "string",
          version: "null-string",
          extends: "null-string",
          capabilityImports: "array",
          profiles: "array",
        },
        "catalog preset manifest",
      ),
    );
  if (record(value.resolved))
    errors.push(
      ...closed(
        value.resolved,
        {
          identity: "object",
          profile: "object",
          templates: "array",
          entrypoints: "array",
          provenance: "object",
          digest: "string",
        },
        "catalog preset resolved",
      ),
    );
  return errors;
}
export function validateCatalogRereadReceipt(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      outcome: "string",
      operationId: "string",
      repoId: "string",
      beforeDigest: "string",
      afterDigest: "string",
      observedAt: "string",
      error: "nullable-object",
    },
    "catalog reread receipt",
  );
  if (!record(value)) return errors;
  errors.push(...errorShape(value.error, "catalog reread error"));
  if (
    value.schema !== "catalog-reread-receipt/v1" ||
    !["applied", "op_rejected"].includes(String(value.outcome)) ||
    !digest(value.beforeDigest) ||
    !digest(value.afterDigest)
  )
    errors.push("catalog reread receipt identity is invalid");
  return errors;
}
export function validateRuntimeSpawnReceipt(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      command: "string",
      outcome: "string",
      opId: "string",
      runtimeSessionId: "null-string",
      dispatchId: "null-string",
      revision: "number",
      evidence: "string",
      visibility: "string",
      proof: "object",
      nextAction: "null-string",
      authorizationDecision: "nullable-object",
    },
    "runtime spawn receipt",
  );
  if (!record(value)) return errors;
  if (value.schema !== "command-receipt/v2") errors.push("runtime spawn receipt schema is invalid");
  return errors;
}

export function validateTerminalSessionList(value: unknown): readonly string[] {
  const errors = closed(
    value,
    { schema: "string", ok: "boolean", repoId: "string", daemonGeneration: "number", sessions: "array" },
    "terminal session list",
  );
  if (!record(value)) return errors;
  if (value.schema !== "terminal-session-list/v1" || !integer(value.daemonGeneration))
    errors.push("terminal session list schema is invalid");
  for (const row of Array.isArray(value.sessions) ? value.sessions : []) {
    errors.push(
      ...closed(
        row,
        {
          sessionId: "string",
          repoId: "string",
          name: "string",
          cwd: "string",
          shellProfile: "string",
          requestedBackend: "string",
          backend: "string",
          status: "string",
          createdAt: "string",
          lastActivityAt: "string",
          exitCode: "null-number",
          outputSeq: "number",
          durability: "string",
          warning: "null-string",
          attachable: "boolean",
        },
        "terminal session",
      ),
    );
    const invalidState =
      record(row) &&
      (!["direct-pty", "tmux"].includes(String(row.requestedBackend)) ||
        !["direct-pty", "tmux"].includes(String(row.backend)) ||
        !["running", "exited", "unknown"].includes(String(row.status)) ||
        !["daemon-process", "daemon-restart"].includes(String(row.durability)) ||
        (row.warning !== null && row.warning !== "tmux-unavailable") ||
        !integer(row.outputSeq));
    if (invalidState) errors.push("terminal session state is invalid");
  }
  return errors;
}
export function validateTerminalControlReceipt(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      outcome: "string",
      operationId: "string",
      sessionId: "null-string",
      daemonGeneration: "number",
      state: "string",
      error: "nullable-object",
    },
    "terminal control receipt",
  );
  if (!record(value)) return errors;
  errors.push(...errorShape(value.error, "terminal control error"));
  if (
    value.schema !== "terminal-control-receipt/v1" ||
    !["applied", "op_rejected"].includes(String(value.outcome)) ||
    !integer(value.daemonGeneration)
  )
    errors.push("terminal control receipt schema is invalid");
  return errors;
}
export function validateTerminalInputAck(value: unknown): readonly string[] {
  const errors = closed(
    value,
    { schema: "string", ok: "boolean", sessionId: "string", acceptedThrough: "number" },
    "terminal input ack",
  );
  if (record(value) && (value.schema !== "terminal-input-ack/v1" || !integer(value.acceptedThrough)))
    errors.push("terminal input ack schema is invalid");
  return errors;
}
export function validateTerminalDetachAck(value: unknown): readonly string[] {
  const errors = closed(
    value,
    { schema: "string", ok: "boolean", sessionId: "string", attachmentId: "string", state: "string" },
    "terminal detach ack",
  );
  if (record(value) && (value.schema !== "terminal-detach-ack/v1" || value.state !== "detached"))
    errors.push("terminal detach ack schema is invalid");
  return errors;
}
export function validateTerminalAttach(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      ok: "boolean",
      sessionId: "string",
      attachmentId: "string",
      daemonGeneration: "number",
      status: "string",
      replayFromSeq: "number",
      outputSeq: "number",
    },
    "terminal attach",
  );
  if (
    record(value) &&
    (value.schema !== "terminal-attach/v1" ||
      !["attached", "gap"].includes(String(value.status)) ||
      !integer(value.daemonGeneration) ||
      !integer(value.replayFromSeq) ||
      !integer(value.outputSeq))
  )
    errors.push("terminal attach schema is invalid");
  return errors;
}
export function validateTerminalAttachEvent(value: unknown): readonly string[] {
  const errors = closed(
    value,
    {
      schema: "string",
      sessionId: "string",
      seq: "number",
      kind: "string",
      utf8: "any-string",
      droppedThrough: "null-number",
      occurredAt: "string",
    },
    "terminal attach event",
  );
  if (
    record(value) &&
    (value.schema !== "terminal-attach-event/v1" ||
      !["output", "gap", "exit"].includes(String(value.kind)) ||
      !integer(value.seq) ||
      (value.droppedThrough !== null && !integer(value.droppedThrough)))
  )
    errors.push("terminal attach event identity is invalid");
  return errors;
}
type ResultValidator = (value: unknown) => readonly string[];
function write<T>(value: T, validate: ResultValidator): T {
  const errors = validate(value);
  if (errors.length) throw new GuiS3ContractError(errors.join("; "));
  return value;
}
export const writeSystemStatus = <T>(value: T): T => write(value, validateSystemStatus),
  writeDaemonControlReceipt = <T>(value: T): T => write(value, validateDaemonControlReceipt),
  writeCatalogSnapshot = <T>(value: T): T => write(value, validateCatalogSnapshot),
  writeCatalogPreset = <T>(value: T): T => write(value, validateCatalogPreset);
export const writeCatalogRereadReceipt = <T>(value: T): T => write(value, validateCatalogRereadReceipt),
  writeTerminalSessionList = <T>(value: T): T => write(value, validateTerminalSessionList),
  writeTerminalControlReceipt = <T>(value: T): T => write(value, validateTerminalControlReceipt);
export const writeTerminalInputAck = <T>(value: T): T => write(value, validateTerminalInputAck),
  writeTerminalDetachAck = <T>(value: T): T => write(value, validateTerminalDetachAck),
  writeTerminalAttach = <T>(value: T): T => write(value, validateTerminalAttach),
  writeTerminalAttachEvent = <T>(value: T): T => write(value, validateTerminalAttachEvent);
