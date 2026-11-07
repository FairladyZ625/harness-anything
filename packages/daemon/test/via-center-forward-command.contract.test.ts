// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1, getExecutableEntityAction } from "@harness-anything/kernel";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import {
  fleetRuntimeRoute,
  fleetScheduleRoute,
  fleetTaskRoute,
  materializeScheduleMission,
} from "@harness-anything/cli/internal/daemon/fleet-command-route";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol-commands.ts";
import { parseFleetFrame } from "../src/fleet/command-protocol.ts";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol-rpc-validation.ts";
import { decisionProposalAction, taskCreateAction } from "../src/repo-cell-action-parse.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";
import { readAgentEntityDeclarationSource } from "../src/agent-entities.ts";

type Command = (typeof daemonProtocolCommands)[number];
type CliInput = {
  readonly name: string;
  readonly kind: "single" | "repeated" | "boolean";
  readonly required: boolean;
  readonly field?: string;
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly projection?: string;
  readonly jsonFields?: readonly string[];
  readonly jsonAllowedFields?: readonly string[];
  readonly conflictsWith?: readonly string[];
  readonly requires?: readonly string[];
  readonly requiresAny?: readonly string[];
  readonly requiredWhen?: { readonly field: string; readonly values: readonly string[] };
};
type Scenario = Readonly<{
  readonly label: string;
  readonly packetInput?: string;
  readonly extraInputs?: readonly string[];
}>;

const taskId = "task-one",
  decisionId = `dec_${"a".repeat(24)}`,
  factId = "F-0000EDGE",
  relationId = `rel_${"a".repeat(16)}`,
  dispatchId = `dispatch_${"a".repeat(24)}`,
  conflictId = `doc-${"a".repeat(64)}`,
  digest = `sha256:${"a".repeat(64)}`;

const kindDeclaration = {
  id: "software/probe",
  entityType: "probe",
  idPrefix: "PRB",
  display: "Probe",
  descriptorSchemaRef: "probe/v1",
  store: "ledger",
  locatorKinds: ["repository-path"],
  attributes: {},
};

function packetValue(field: string): unknown {
  if (field === "chosen") return [{ id: "CH1", text: "Probe choice" }];
  if (field === "rejected")
    return [{ id: "RJ1", text: "Require an edge path.", whyNot: "Paths stay on their owner node." }];
  if (field === "responses")
    return [{ reviewId: "review-one", findingId: "G1", disposition: "adopt", rationale: "Addressed." }];
  if (["claims", "findings", "evidenceChecked", "resolutions", "fulfillments", "relations"].includes(field)) return [];
  if (field === "appliesTo") return { modules: [], productLines: [] };
  if (field === "reviewIds") return ["review-one"];
  if (field === "reviewContentDigest") return digest;
  if (field === "decisionRef") return decisionId;
  if (field === "riskTier" || field === "urgency") return "low";
  if (field === "decisionClass") return "ordinary";
  if (field === "verdict") return "approved";
  if (field === "everyMs") return 60_000;
  if (field === "scheduleId") return "schedule-one";
  if (field === "taskId") return taskId;
  if (field === "executionId") return "execution-one";
  if (field === "reviewId") return "review-one";
  if (field === "expectedVersion" || field === "revision") return 0;
  if (field === "fast" || field === "keepMonthly") return true;
  if (field === "id") return kindDeclaration.id;
  if (field === "entityType") return kindDeclaration.entityType;
  if (field === "idPrefix") return kindDeclaration.idPrefix;
  if (field === "display") return kindDeclaration.display;
  if (field === "descriptorSchemaRef") return kindDeclaration.descriptorSchemaRef;
  if (field === "store") return kindDeclaration.store;
  if (field === "locatorKinds") return kindDeclaration.locatorKinds;
  if (field === "attributes") return {};
  if (field === "tokenId") return "det_probe";
  if (field === "runtimeSessionId") return "session-one";
  if (field === "action") return ["task.read"];
  if (field === "expiresAt") return "2026-11-07T00:00:00.000Z";
  return field === "title" ? "Probe packet" : `Probe ${field}`;
}

function packetFor(command: Command, input: CliInput): Record<string, unknown> {
  const packet = Object.fromEntries((input.jsonFields ?? []).map((field) => [field, packetValue(field)]));
  if (command.id === "schedule-update") packet.name = "Probe schedule";
  return packet;
}

function fieldFor(input: CliInput): string {
  return input.field ?? input.name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
}

function regexCandidate(pattern: string): string {
  const candidates = [
    "task-one",
    taskId,
    "task/task-one",
    "task/task-one/probe.md",
    "dec_aaaaaaaaaaaaaaaaaaaaaaaa",
    decisionId,
    factId,
    "fact/F-0000EDGE",
    "F-0000EDGE:Probe rationale",
    "C1",
    "C1:evidenced",
    "CH1",
    "det_probe",
    "agent-one",
    "probe-agent",
    "dispatch-1",
    dispatchId,
    "sha256:" + "a".repeat(64),
    "a".repeat(40),
    "title:Probe title",
    "state:active",
    "fix:memory:Probe",
    "task/task-one@abcdef123456",
    "refs/heads/main",
    "2026-11-07T00:00:00.000Z",
    "100",
    "0",
    "none",
    "node-modules",
    "probe",
  ];
  const regexp = new RegExp(pattern, "u"),
    matched = candidates.find((candidate) => regexp.test(candidate));
  return matched ?? "probe";
}

function candidate(command: Command, input: CliInput): string {
  if (input.enum?.length) return input.enum[0]!;
  if (input.regex) return regexCandidate(input.regex);
  if (input.format === "<task-id>") return taskId;
  if (input.projection === "json-object")
    return input.name === "--declaration" ? JSON.stringify(kindDeclaration) : "{}";
  if (["--from-file", "--ids-file", "--plan-file", "--body-file"].includes(input.name))
    return input.name === "--from-file"
      ? `tasks/task-one/artifacts/${command.id}-packet.json`
      : input.name === "--ids-file"
        ? "ids.txt"
        : input.name === "--plan-file"
          ? "tasks/task-one/plan.md"
          : "tasks/task-one/artifacts/body.md";
  if (input.name === "--mission-file") return "body.md";
  if (input.name === "--source" && command.id === "task-artifact-add") return "artifact.bin";
  if (input.name === "--source" && command.id === "agent-install") return "agent.json";
  if (input.name === "--source" && command.id === "squad-install") return "squad.json";
  if (input.name === "--source" && command.id === "fact-record") return "test:probe";
  if (input.name === "--kind" && command.id === "vertical-kind-upsert") return kindDeclaration.id;
  if (input.name === "--id" && command.id.startsWith("decision-claim-")) return "C1";
  if (input.name === "--path") return "context/probe.md";
  if (input.name === "--soft" || input.name === "--hard") return taskId;
  if (input.name === "--set") return "title:Probe title";
  if (input.name === "--input" && command.id === "distill-candidate") return "tasks/task-one/context/input.md";
  const values: Readonly<Record<string, string>> = {
    taskId,
    oldTaskId: taskId,
    parentTaskId: "task-parent",
    todoId: "todo-one",
    entityRef: "task/task-one",
    entityKind: "software/probe",
    entityId: "probe-one",
    kindId: kindDeclaration.id,
    agentId: "agent-one",
    squadId: "squad-one",
    scheduleId: "schedule-one",
    factId,
    decisionId,
    relationId,
    dispatchId,
    conflictId,
    type: "fix",
    tokenId: "det_probe",
    runtimeSessionId: "session-one",
    expectedVersion: "0",
    every: "1m",
    cron: "0 * * * *",
    timezone: "UTC",
    mission: "Probe mission",
    missionFile: "body.md",
    status: "planned",
    title: "Probe title",
    question: "Probe question?",
    reason: "Probe reason",
    rationale: "Probe rationale",
    statement: "Probe statement",
    text: "Probe text",
    evidenceSource: "test:probe",
    decisionRef: decisionId,
    reviewId: "review-one",
    executionId: "execution-one",
    gateId: "gate-one",
    runId: "run-one",
    targetRef: "task/task-two",
    sourceRef: "task/task-one",
    target: "task/task-two",
    source: "task/task-one",
    personId: "person-one",
    dispatchKey: "dispatch-key-one",
    prompt: "Probe prompt",
    runtimeInstanceId: "instance-one",
    idempotencyKey: "idempotency-one",
    verdict: "approved",
    reviewContentDigest: digest,
    contentSha256: "a".repeat(64),
    contentRevision: "1",
    scriptId: "vertical:software-coding:repository-audit",
    destination: "artifacts/evidence/probe.txt",
    name: "Probe name",
    mode: "detect",
    inputPath: "tasks/task-one/context/input.md",
    candidatePath: "tasks/task-one/context/candidate.md",
    statement: "Probe claim",
    claimId: "C1",
    operation: "claim",
    answer: "Probe answer",
    model: "probe-model",
    effort: "low",
    recommendation: "Probe recommendation",
    observedAt: "2026-11-07T00:00:00.000Z",
    reportRef: "tasks/task-one/artifacts/report.md",
  };
  const value = values[fieldFor(input)] ?? values[input.name.slice(2)] ?? "probe";
  return input.kind === "repeated" && input.name === "--type" ? "fix" : value;
}

function sourceInputs(command: Command): readonly CliInput[] {
  return (command.inputs as readonly CliInput[]).filter(
    (input) => (input.name === "--from-file" || input.name === "--json-input") && input.jsonFields,
  );
}

function scenarios(command: Command): readonly Scenario[] {
  const inputs = command.inputs as readonly CliInput[],
    result: Scenario[] =
      command.id === "task-archive"
        ? [
            { label: "task-id" },
            { label: "--ids", extraInputs: ["--ids"] },
            { label: "--filter", extraInputs: ["--filter"] },
          ]
        : [{ label: "declared inputs" }];
  for (const input of sourceInputs(command)) result.push({ label: input.name, packetInput: input.name });
  if (command.id === "decision-repin") result.push({ label: "--all", extraInputs: ["--all"] });
  for (const input of inputs.filter((value) => value.projection === "json-object"))
    result.push({ label: input.name, extraInputs: [input.name] });
  for (const input of inputs.filter((value) =>
    ["--body-file", "--plan-file", "--ids-file", "--mission-file"].includes(value.name),
  )) {
    const isScheduleMission =
        ["schedule-create", "schedule-update"].includes(command.id) && input.name === "--mission-file",
      packetInput = isScheduleMission
        ? undefined
        : sourceInputs(command).find((source) => source.name === "--from-file")?.name;
    result.push({ label: input.name, ...(packetInput ? { packetInput } : {}), extraInputs: [input.name] });
  }
  for (const source of sourceInputs(command))
    for (const body of inputs.filter((value) => ["--body", "--body-file"].includes(value.name)))
      if (!body.conflictsWith?.includes(source.name) && !source.conflictsWith?.includes(body.name))
        result.push({ label: `${source.name} + ${body.name}`, packetInput: source.name, extraInputs: [body.name] });
  return result;
}

function positionalValue(command: Command, token: string): string {
  const unwrapped = token.startsWith("[") && token.endsWith("]") ? token.slice(1, -1) : token,
    named = unwrapped.startsWith("<") && unwrapped.endsWith(">") ? unwrapped.slice(1, -1) : unwrapped,
    value = named.split("|")[0]!;
  if (value.includes("task-id")) return taskId;
  if (value === "id" && command.id.startsWith("decision-claim-")) return "C1";
  if (value === "id" && command.id.startsWith("script-")) return "vertical:software-coding:repository-audit";
  if (value.includes("decision") || (value === "id" && command.path[0] === "decision")) return decisionId;
  if (value.includes("fact-id")) return factId;
  if (value.includes("relation-id")) return relationId;
  if (value.includes("dispatch-id")) return dispatchId;
  if (value.includes("schedule-id")) return "schedule-one";
  if (value.includes("agent-id")) return "agent-one";
  if (value.includes("squad-id")) return "squad-one";
  if (value.includes("todo-id")) return "todo-one";
  if (value.includes("conflict-id")) return conflictId;
  if (["planned", "active", "blocked", "in_review", "done", "cancelled", "status"].includes(value))
    return value === "status" ? "planned" : value;
  if (value.includes("superseded") || value.includes("target-state")) return "superseded";
  if (value.includes("entity-kind") || value.includes("kind-id")) return kindDeclaration.id;
  return "probe-one";
}

function addFlag(argv: string[], used: Set<string>, command: Command, input: CliInput, root: string): void {
  if (used.has(input.name)) return;
  if ([...used].some((name) => input.conflictsWith?.includes(name))) return;
  if (input.kind === "boolean") argv.push(input.name);
  else {
    let value = candidate(command, input);
    if (input.name === "--from-file") {
      const file = path.join(root, value);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(packetFor(command, input))}\n`);
    } else if (input.name === "--json-input" && input.jsonFields) value = JSON.stringify(packetFor(command, input));
    argv.push(input.name, value);
  }
  used.add(input.name);
}

function commandArgv(command: Command, root: string, scenario: Scenario): string[] {
  const syntax = "syntaxPath" in command ? command.syntaxPath : command.path,
    isPositional = (token: string) =>
      (token.startsWith("<") && token.endsWith(">")) || (token.startsWith("[") && token.endsWith("]")),
    commandPath = command.path.filter((token) => !isPositional(token)),
    positional = syntax
      .filter(isPositional)
      .filter(
        () =>
          !(
            (command.id === "task-archive" && scenario.label !== "task-id") ||
            (command.id === "decision-repin" && scenario.label === "--all")
          ),
      ),
    argv = [...commandPath, ...positional.map((token) => positionalValue(command, token))],
    inputs = command.inputs as readonly CliInput[];
  const used = new Set<string>(),
    packetInput =
      inputs.find((input) => input.name === scenario.packetInput) ??
      (scenario.label === "declared inputs"
        ? sourceInputs(command).find((input) => input.name === "--from-file")
        : undefined);
  if (packetInput) {
    const raw = JSON.stringify(packetFor(command, packetInput));
    if (packetInput.name === "--from-file") {
      const file = path.join(root, candidate(command, packetInput));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${raw}\n`);
    }
    argv.push(packetInput.name, packetInput.name === "--from-file" ? candidate(command, packetInput) : raw);
    used.add(packetInput.name);
    for (const conflict of packetInput.conflictsWith ?? []) used.add(conflict);
  }
  for (const name of scenario.extraInputs ?? []) {
    const input = inputs.find((entry) => entry.name === name);
    if (input) addFlag(argv, used, command, input, root);
  }
  const requiredInputs = inputs.filter((input) => input.required);
  for (const input of requiredInputs) addFlag(argv, used, command, input, root);
  const action = getExecutableEntityAction("actionKind" in command ? command.actionKind : command.id),
    constraints = [
      ...("actionConstraints" in command && command.actionConstraints ? command.actionConstraints : []),
      ...(action?.input.exactlyOneOf ?? []),
    ];
  for (const group of constraints) {
    if (command.id === "task-archive" && scenario.label !== "declared inputs") continue;
    const selected = inputs.filter((input) => group.includes(input.field ?? fieldFor(input)) && used.has(input.name));
    if (selected.length > 0) continue;
    const choice = inputs.find((input) => group.includes(input.field ?? fieldFor(input)));
    if (choice) addFlag(argv, used, command, choice, root);
  }
  if (command.id === "schedule-create") {
    for (const name of [
      "--name",
      "--mode",
      "--every",
      "--agent",
      ...(scenario.label === "--mission-file" ? [] : ["--mission"]),
    ]) {
      const input = inputs.find((entry) => entry.name === name)!;
      addFlag(argv, used, command, input, root);
    }
  }
  if (command.id === "schedule-update" && scenario.label === "--mission-file") {
    const name = inputs.find((entry) => entry.name === "--name");
    if (name) addFlag(argv, used, command, name, root);
  }
  if (
    command.id === "decision-amend" &&
    !["--title", "--body", "--body-file", "--set", "--append"].some((name) => used.has(name))
  ) {
    const change = inputs.find((input) => input.name === "--set");
    if (change) addFlag(argv, used, command, change, root);
  }
  if (command.id === "decision-propose" && !used.has("--body") && !used.has("--body-file")) {
    const body = inputs.find((input) => input.name === "--body");
    if (body) addFlag(argv, used, command, body, root);
  }
  if (command.id === "fact-record" && !used.has("--statement") && !used.has("--text")) {
    const statement = inputs.find((input) => input.name === "--statement");
    if (statement) addFlag(argv, used, command, statement, root);
  }
  if (command.id === "task-artifact-add" && used.has("--source")) {
    const destination = inputs.find((input) => input.name === "--destination");
    if (destination) addFlag(argv, used, command, destination, root);
  }
  if (command.id === "task-create" && !used.has("--from-file") && !used.has("--json-input")) {
    const title = inputs.find((input) => input.name === "--title");
    if (title) addFlag(argv, used, command, title, root);
  }
  if (command.id === "schedule-update" && !packetInput) {
    const name = inputs.find((input) => input.name === "--name");
    if (name) addFlag(argv, used, command, name, root);
  }
  if (command.id === "doc-sync-submit") {
    const all = inputs.find((input) => input.name === "--all");
    if (all) addFlag(argv, used, command, all, root);
  }
  if (command.id === "decision-repin" && !argv.includes("--all") && !argv.some((value) => value === decisionId)) {
    const all = inputs.find((input) => input.name === "--all");
    if (all) addFlag(argv, used, command, all, root);
  }
  if (command.id === "task-delete") {
    const soft = inputs.find((input) => input.name === "--soft"),
      reason = inputs.find((input) => input.name === "--reason");
    if (soft) addFlag(argv, used, command, soft, root);
    if (reason) addFlag(argv, used, command, reason, root);
  }
  if (packetInput && ["schedule-update", "schedule-delete"].includes(command.id)) {
    const scheduleIdPosition = argv.indexOf("schedule-one");
    if (scheduleIdPosition >= 0) argv.splice(scheduleIdPosition, 1);
  }
  if (scenario.extraInputs?.includes("--ids-file") && command.id === "fact-archive") {
    const factIdPosition = argv.indexOf(factId);
    if (factIdPosition >= 0) argv.splice(factIdPosition, 1);
  }
  return ["--root", root, ...argv];
}

function setupRoot(t: { after(callback: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-via-center-forward-"))),
    userRoot = path.join(root, "user");
  mkdirSync(userRoot);
  writeFileSync(
    path.join(root, "fleet-edge.json"),
    `${JSON.stringify({ schema: "fleet-edge-config/v1", repoId: "probe-repo", host: "center", port: 7443, caPath: "/fleet/ca.pem", nodeId: "edge-one", credential: "fixture-credential", viewRoot: "/view", quotaBytes: 65_536 })}\n`,
  );
  writeFileSync(
    path.join(userRoot, "registry.json"),
    `${JSON.stringify({ schema: "harness-daemon-registry/v2", connections: [{ id: "local", kind: "local", displayName: "Fixture", state: "enabled" }], repos: [{ repoId: "probe-repo", canonicalRoot: root, displayName: "Fixture", authoredBranch: "main", mode: "remote-edge", connectionId: "local", state: "enabled", registeredAt: "2026-11-01T00:00:00.000Z" }] })}\n`,
  );
  writeFileSync(path.join(root, "body.md"), "Probe body.\n");
  mkdirSync(path.join(root, "tasks/task-one/artifacts"), { recursive: true });
  writeFileSync(path.join(root, "tasks/task-one/plan.md"), "Probe plan.\n");
  writeFileSync(path.join(root, "tasks/task-one/artifacts/body.md"), "Probe body.\n");
  writeFileSync(path.join(root, "ids.txt"), `${factId}\n`);
  writeFileSync(path.join(root, "artifact.bin"), "fixture artifact\n");
  writeFileSync(
    path.join(root, "agent.json"),
    JSON.stringify({
      schema: "agent-declaration/v1",
      id: "probe-agent",
      name: "Probe",
      instructions: "Probe",
      runtimes: [{ type: "codex" }],
    }),
  );
  writeFileSync(
    path.join(root, "squad.json"),
    JSON.stringify({
      schema: "squad-declaration/v1",
      id: "probe-squad",
      name: "Probe",
      leader: "probe-agent",
      workers: ["probe-agent"],
      leaderTurnBudget: 1,
      roster: "Probe",
    }),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { HARNESS_DAEMON_USER_ROOT: userRoot } };
}

function jsonWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function wireFrame(action: Record<string, unknown>): unknown {
  return parseFleetFrame(
    JSON.stringify({
      schema: "fleet.task.command/v1",
      messageId: "message-one",
      writerEpoch: 1,
      opId: "op-one",
      repoId: "probe-repo",
      taskId: typeof action.taskId === "string" ? action.taskId : null,
      action,
      docChanges: null,
      mirrorBaseCut: null,
    }),
  );
}

function assertDirectActionFields(
  descriptor: Command,
  inputAction: Readonly<Record<string, unknown>>,
  outputAction: Readonly<Record<string, unknown>>,
): void {
  const edgeOnly = new Set([
    "executor",
    "createMode",
    "verb",
    "commandType",
    "fromFile",
    "jsonInput",
    "planFile",
    "bodyFile",
    "idsFile",
  ]);
  for (const [field, value] of Object.entries(jsonWire(inputAction) as Record<string, unknown>)) {
    if (edgeOnly.has(field)) continue;
    if (descriptor.id === "agent-install" || descriptor.id === "squad-install") continue;
    assert.deepEqual(outputAction[field], value, `${descriptor.id} lost CLI field ${field}`);
  }
}

function assertRepoCellActionParsers(root: string, command: Command, action: Record<string, unknown>): void {
  let resolved: RepoTaskAction | undefined;
  if (action.kind === "task-create") resolved = taskCreateAction(root, action as RepoTaskAction);
  if (action.kind === "decision-propose")
    resolved = decisionProposalAction(root, action as RepoTaskAction, () => INITIAL_SETTINGS_V1);
  if (!resolved) return;
  for (const [field, value] of Object.entries(action))
    assert.deepEqual(resolved[field], value, `${command.id} repo-cell action parser changed field ${field}`);
}

test("each remote-edge via-center-forward declaration reaches its matching fleet wire parser", async (t) => {
  const { root, env } = setupRoot(t),
    commands = daemonProtocolCommands.filter((command) => command.admission["remote-edge"] === "via-center-forward"),
    failures: string[] = [];
  assert.ok(commands.length > 0);
  for (const descriptor of commands) {
    for (const scenario of scenarios(descriptor)) {
      const argv = commandArgv(descriptor, root, scenario),
        parsed = parseThinCommand(argv, root);
      if (!parsed.ok) {
        failures.push(
          `${descriptor.id} [${scenario.label}]: CLI rejected generated declaration inputs (${parsed.code}: ${parsed.nextAction}); argv=${JSON.stringify(argv)}`,
        );
        continue;
      }
      try {
        const command = materializeScheduleMission(parsed.command),
          schedule = await fleetScheduleRoute(command, env),
          runtime = schedule ? null : await fleetRuntimeRoute(command, env),
          task = schedule || runtime ? null : await fleetTaskRoute(command, env),
          centerRoute = schedule ?? runtime ?? task,
          action = task?.action as Record<string, unknown> | undefined;
        assert.ok(centerRoute, `${descriptor.id} has no edge route`);
        const centerParams = parseDaemonRpcParams("daemon.fleet.task.run", { payload: centerRoute });
        assert.ok(
          centerParams.ok,
          `${descriptor.id} rejected by center daemon.fleet.task.run parser: ${centerParams.ok ? "" : centerParams.errors.join("; ")}`,
        );
        if (schedule) {
          const payload = (schedule.action as { payload: Record<string, unknown> }).payload,
            frame = parseFleetFrame(
              JSON.stringify({
                schema: "fleet.schedule.command/v1",
                messageId: "message-one",
                writerEpoch: 1,
                opId: "op-one",
                repoId: "probe-repo",
                scheduleId: payload.scheduleId,
                action: payload,
              }),
            );
          assert.deepEqual(
            (frame as { action: unknown }).action,
            jsonWire(payload),
            `${descriptor.id} schedule fields changed on wire`,
          );
          if (scenario.label === "--mission-file")
            assert.equal(payload.mission, "Probe body.\n", `${descriptor.id} lost mission-file text`);
        } else if (runtime) {
          const routed = runtime.action as { method: string; payload: Record<string, unknown> },
            original = command.action as Record<string, unknown>,
            expected = Object.fromEntries(
              Object.entries(original).filter(
                ([field]) => !["kind", "executor", "wait", "noStream", "detach"].includes(field),
              ),
            );
          assert.ok(routed.method, descriptor.id);
          assert.deepEqual(routed.payload, jsonWire(expected), `${descriptor.id} runtime fields changed on edge route`);
          if (routed.method !== "repo.squad.control") {
            const centerRuntimeParams = parseDaemonRpcParams(routed.method, {
              repo: { repoId: runtime.repoId },
              payload: routed.payload,
            });
            assert.ok(
              centerRuntimeParams.ok,
              `${descriptor.id} rejected by center ${routed.method} parser: ${centerRuntimeParams.ok ? "" : centerRuntimeParams.errors.join("; ")}`,
            );
          }
        } else if (action) {
          let wireAction = action;
          if (
            (action.kind === "agent-install" || action.kind === "squad-install") &&
            typeof action.packageSource === "string"
          ) {
            const decoded = readAgentEntityDeclarationSource(action);
            if ("issues" in decoded) throw new Error(decoded.issues[0]?.message ?? "agent declaration rejected");
            const { packageSource: _packageSource, ...withoutPath } = action;
            wireAction = { ...withoutPath, declaration: decoded.declaration, declarationSource: decoded.source };
          }
          if (action.kind === "task-artifact-add" && typeof action.source === "string") {
            const { source: _source, ...withoutSource } = action;
            wireAction = withoutSource;
          }
          const frame = wireFrame(wireAction);
          assert.deepEqual(
            (frame as { action: unknown }).action,
            jsonWire(wireAction),
            `${descriptor.id} action changed during Fleet serialization`,
          );
          assertDirectActionFields(descriptor, command.action as Record<string, unknown>, action);
          assertRepoCellActionParsers(root, descriptor, (frame as { action: Record<string, unknown> }).action);
          for (const source of sourceInputs(descriptor)) {
            if (scenario.packetInput !== source.name) continue;
            for (const [field, value] of Object.entries(packetFor(descriptor, source)))
              assert.deepEqual(
                descriptor.id === "vertical-kind-upsert"
                  ? (action.declaration as Record<string, unknown>)?.[field]
                  : action[field],
                value,
                `${descriptor.id} lost packet field ${field}`,
              );
          }
          if (typeof command.action.bodyFile === "string")
            assert.equal(action.body, "Probe body.\n", `${descriptor.id} lost edge body-file text`);
          if (typeof command.action.planFile === "string")
            assert.equal(action.plan, "Probe plan.\n", `${descriptor.id} lost edge plan-file text`);
          if (typeof command.action.idsFile === "string")
            assert.deepEqual(action.factIds, [factId], `${descriptor.id} lost edge ids-file values`);
        } else {
          failures.push(`${descriptor.id} [${scenario.label}]: no edge route matched its declaration`);
        }
      } catch (error) {
        failures.push(
          `${descriptor.id} [${scenario.label}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `${commands.length} registry declarations and generated input variants were exercised; failures:\n${failures.join("\n")}`,
  );
});

test("a registry declaration without a CLI parser is reported as a matrix failure", (t) => {
  const selected = daemonProtocolCommands.filter(
      (command) => command.admission["remote-edge"] === "via-center-forward",
    ),
    { root } = setupRoot(t),
    added = {
      ...selected[0]!,
      id: "probe-new-forward-command",
      path: ["task", "new-forward-command", "<task-id>"],
      syntaxPath: ["task", "new-forward-command", "<task-id>"],
      actionKind: "probe-new-forward-command",
    } as Command;
  assert.equal(
    [...selected, added].filter((command) => command.admission["remote-edge"] === "via-center-forward").length,
    selected.length + 1,
  );
  const parsed = parseThinCommand(commandArgv(added, root, { label: "declared inputs" }), root, [
    ...daemonProtocolCommands,
    added,
  ] as typeof daemonProtocolCommands);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) t.diagnostic(`${added.id} is caught by the CLI leg: ${parsed.code}: ${parsed.nextAction}`);
  assert.throws(() => wireFrame({ kind: added.actionKind }), /not a via-center-forward command/u);
});
