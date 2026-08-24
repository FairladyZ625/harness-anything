import { cliInput, defineCliCommand } from "../../../preset/src/preset-command-contract.ts";
import { daemonRepoModeWords } from "./daemon-protocol-vocabulary.ts";

export const runtimeConfigProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "daemon-projection-rebuild",
    phase: "B2-S1",
    path: ["daemon", "projection", "rebuild"],
    summary: "Rebuild the local task projection in place from the canonical ledger.",
    method: "repo.task.run",
    actionKind: "projection-rebuild",
    commandClass: "repo-write",
    inputs: [],
  }),
  defineCliCommand({
    id: "daemon-repo-register",
    phase: "W3",
    path: ["daemon", "repo", "register"],
    summary: "Register an initialized workspace with an explicit service mode.",
    method: "daemon.repo.register",
    commandClass: "admin",
    inputs: [
      cliInput("--repo-id", "single", true, {
        code: "missing_field",
        nextAction: "Register requires --repo-id and --root.",
      }),
      cliInput("--root", "single", true, {
        code: "missing_field",
        nextAction: "Register requires --repo-id and --root.",
      }),
      cliInput(
        "--mode",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use local, remote-center, or remote-edge.",
        },
        { enum: daemonRepoModeWords },
      ),
    ],
  }),
  defineCliCommand({
    id: "daemon-repo-unregister",
    phase: "W3",
    path: ["daemon", "repo", "unregister"],
    summary: "Disable a registered workspace.",
    method: "daemon.repo.unregister",
    commandClass: "admin",
    inputs: [
      cliInput("--repo-id", "single", true, {
        code: "missing_field",
        nextAction: "Unregister requires --repo-id.",
      }),
    ],
  }),
  defineCliCommand({
    id: "daemon-start",
    phase: "W3",
    path: ["daemon", "start", "--service"],
    summary: "Explicitly start the resident daemon.",
    method: "protocol.hello",
    commandClass: "admin",
    inputs: [],
  }),
  defineCliCommand({
    id: "daemon-status",
    phase: "W3",
    path: ["daemon", "status"],
    summary: "Show daemon and RepoCell status.",
    method: "daemon.status",
    commandClass: "repo-read",
    inputs: [],
  }),
  defineCliCommand({
    id: "runtime-instance-create",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "create"],
    summary: "Create one machine-local runtime instance bound to a witnessed installation.",
    method: "daemon.runtimeInstance.create",
    commandClass: "admin",
    inputs: [
      cliInput(
        "--id",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: "Runtime instance create requires --id.",
        },
        { regex: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      ),
      cliInput("--name", "single", true, {
        code: "missing_field",
        nextAction: "Runtime instance create requires --name.",
      }),
      cliInput(
        "--kind",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Runtime kind must be claude, codex, or agy.",
        },
        { enum: ["claude", "codex", "agy"] },
      ),
      cliInput("--installation", "single", false, {
        code: "invalid_field",
        nextAction: [
          "Choose an installation returned by runtime instance list, or omit it ",
          "when the kind has exactly one witnessed installation.",
        ].join(""),
      }),
      cliInput("--provider", "single", true, {
        code: "missing_field",
        nextAction: "Runtime instance create requires --provider.",
      }),
      cliInput("--model", "repeated", true, {
        code: "missing_field",
        nextAction: [
          "Runtime instance create requires at least one --model; repeat --model to ",
          "let one instance serve several models.",
        ].join(""),
      }),
      cliInput("--default-model", "single", false, {
        code: "invalid_field",
        nextAction: "Use one model from the --model set; the first --model is the default when omitted.",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
          nextAction: "Use bypass (default, full access), workspace-write, or read-only; claude and codex only.",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput(
        "--isolation",
        "single",
        false,
        {
          code: "invalid_runtime_isolation",
          nextAction: [
            "Use enforced or operator-environment; codex defaults to enforced and ",
            "requires it for API-key auth, and agy always reuses the operator ",
            "environment.",
          ].join(""),
        },
        { enum: ["enforced", "operator-environment"] },
      ),
      cliInput("--effort", "single", false, {
        code: "invalid_field",
        nextAction:
          "Use a kind-supported reasoning effort: agy low, medium, high; Codex minimal, low, medium, high, xhigh.",
      }),
      cliInput("--base-url", "single", false, {
        code: "invalid_field",
        nextAction: "Use an HTTPS or loopback HTTP API base URL.",
      }),
      cliInput("--wire-api", "single", false, {
        code: "invalid_field",
        nextAction: "Use one Codex provider wire API identifier.",
      }),
      cliInput("--requires-openai-auth", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --requires-openai-auth only for a Codex provider.",
      }),
      cliInput("--http-header", "repeated", false, {
        code: "invalid_field",
        nextAction: "Use --http-header Name=Value only for non-secret static Codex provider headers.",
      }),
      cliInput(
        "--auth",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Auth mode must be subscription or api-key.",
        },
        { enum: ["subscription", "api-key"] },
      ),
      cliInput(
        "--credential-ref",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: [
            "Use an opaque credential:v1 reference (legacy keychain: references ",
            "resolve on macOS only); never pass the API key.",
          ].join(""),
        },
        {
          regex: "^credential:v1:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$|^keychain:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$",
        },
      ),
    ],
  }),
  defineCliCommand({
    id: "runtime-instance-list",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "list"],
    summary: [
      "List enabled runtime instances and currently witnessed installations ",
      "without secrets or host paths; use --all to include disabled instances.",
    ].join(""),
    method: "daemon.runtimeInstance.list",
    commandClass: "admin",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --all to include disabled runtime instances.",
      }),
    ],
  }),
  defineCliCommand({
    id: "runtime-instance-show",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "show", "<instance-id>"],
    positional: "instanceId",
    summary: "Show one redacted machine-local runtime instance; use --probe to verify provider authentication.",
    method: "daemon.runtimeInstance.show",
    commandClass: "admin",
    inputs: [
      cliInput("--probe", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --probe once to actively verify provider authentication.",
      }),
    ],
  }),
  defineCliCommand({
    id: "runtime-instance-delete",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "delete", "<instance-id>"],
    positional: "instanceId",
    summary: "Delete one runtime instance and any instance-managed state.",
    method: "daemon.runtimeInstance.delete",
    commandClass: "admin",
    inputs: [],
  }),
  defineCliCommand({
    id: "runtime-instance-update",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "update", "<instance-id>"],
    positional: "instanceId",
    summary: [
      "Update a runtime instance's installation, metadata, models, permissions, ",
      "isolation, or enabled state without touching credentials.",
    ].join(""),
    method: "daemon.runtimeInstance.update",
    commandClass: "admin",
    inputs: [
      cliInput("--name", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty --name.",
      }),
      cliInput("--installation", "single", false, {
        code: "invalid_field",
        nextAction: "Choose a same-kind installation returned by runtime instance list.",
      }),
      cliInput("--model", "repeated", false, {
        code: "invalid_field",
        nextAction: "Repeat --model once per supported model.",
      }),
      cliInput("--default-model", "single", false, {
        code: "invalid_field",
        nextAction: "Use one model from the updated --model set.",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
          nextAction: "Use bypass, workspace-write, or read-only; claude and codex only.",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput(
        "--isolation",
        "single",
        false,
        {
          code: "invalid_runtime_isolation",
          nextAction: [
            "Use enforced or operator-environment; codex defaults to enforced and ",
            "requires it for API-key auth, and agy always reuses the operator ",
            "environment.",
          ].join(""),
        },
        { enum: ["enforced", "operator-environment"] },
      ),
      cliInput("--enable", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --enable or --disable, not both.",
      }),
      cliInput("--disable", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --enable or --disable, not both.",
      }),
    ],
  }),
  defineCliCommand({
    id: "runtime-instance-login",
    phase: "Runtime-Instances-S3",
    path: ["runtime", "instance", "login", "<instance-id>"],
    positional: "instanceId",
    summary: "Bridge your terminal to provider-native sign-in when supported by the runtime kind.",
    method: "repo.runtimeInstance.auth.login",
    commandClass: "repo-write",
    inputs: [
      cliInput("--idempotency-key", "single", false, {
        code: "invalid_field",
        nextAction: "Use one stable non-empty idempotency key, or omit it for automatic allocation.",
      }),
    ],
  }),
  defineCliCommand({
    id: "runtime-instance-logout",
    phase: "Runtime-Instances-S3",
    path: ["runtime", "instance", "logout", "<instance-id>"],
    positional: "instanceId",
    summary: "Remove provider credentials through provider-native sign-out when supported by the runtime kind.",
    method: "repo.runtimeInstance.auth.logout",
    commandClass: "repo-write",
    inputs: [
      cliInput("--idempotency-key", "single", false, {
        code: "invalid_field",
        nextAction: "Use one stable non-empty idempotency key, or omit it for automatic allocation.",
      }),
    ],
  }),
] as const);
