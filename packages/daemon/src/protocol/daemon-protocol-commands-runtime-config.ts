import {
  defineCenterRepairWriteCommand,
  cliInput,
  defineHostAdminCommand,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";
import { daemonRepoModeWords } from "./daemon-protocol-vocabulary.ts";

const credentialReferenceRegex =
  "^credential:v1:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$|^keychain:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$";

export const runtimeConfigProtocolCommands = Object.freeze([
  defineCenterRepairWriteCommand({
    id: "daemon-projection-rebuild",
    phase: "B2-S1",
    path: ["daemon", "projection", "rebuild"],
    summary: "Rebuild the local task projection in place from the canonical ledger.",
    method: "repo.task.run",
    actionKind: "projection-rebuild",
    inputs: [],
  }),
  defineHostAdminCommand({
    id: "daemon-repo-register",
    phase: "W3",
    path: ["daemon", "repo", "register"],
    summary: "Register an initialized workspace with an explicit service mode.",
    method: "daemon.repo.register",
    inputs: [
      cliInput("--repo-id", "single", true, {
        code: "missing_field",
      }),
      cliInput("--root", "single", false, {
        code: "missing_field",
      }),
      cliInput(
        "--mode",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: daemonRepoModeWords },
      ),
      cliInput("--endpoint", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--connection", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--display-name", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-repo-update",
    phase: "PLT-EdgeGUI-W2",
    path: ["daemon", "repo", "update"],
    summary: "Update one machine-local repository registration.",
    method: "daemon.repo.update",
    inputs: [
      cliInput("--repo-id", "single", true, {
        code: "missing_field",
      }),
      cliInput("--display-name", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--mode",
        "single",
        false,
        { code: "invalid_field" },
        {
          enum: daemonRepoModeWords,
        },
      ),
      cliInput("--connection", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--endpoint", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--state",
        "single",
        false,
        { code: "invalid_field" },
        {
          enum: ["enabled", "disabled"],
        },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-repo-unregister",
    phase: "W3",
    path: ["daemon", "repo", "unregister"],
    summary: "Disable a registered workspace.",
    method: "daemon.repo.unregister",
    inputs: [
      cliInput("--repo-id", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-connection-add",
    phase: "PLT-EdgeGUI-W2",
    path: ["daemon", "connection", "add"],
    summary: "Add a remote daemon endpoint connection.",
    method: "daemon.connection.register",
    inputs: [
      cliInput("--connection", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--display-name", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--endpoint", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-connection-update",
    phase: "PLT-EdgeGUI-W2",
    path: ["daemon", "connection", "update"],
    summary: "Update a remote daemon endpoint connection.",
    method: "daemon.connection.update",
    inputs: [
      cliInput("--connection", "single", true, {
        code: "missing_field",
      }),
      cliInput("--display-name", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--endpoint", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--state",
        "single",
        false,
        { code: "invalid_field" },
        {
          enum: ["enabled", "disabled"],
        },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-connection-remove",
    phase: "PLT-EdgeGUI-W2",
    path: ["daemon", "connection", "remove"],
    summary: "Disable a remote daemon endpoint connection.",
    method: "daemon.connection.unregister",
    inputs: [
      cliInput("--connection", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-connection-probe",
    phase: "PLT-EdgeGUI-W2",
    path: ["daemon", "connection", "probe"],
    summary: "Probe a remote daemon endpoint and list its repositories.",
    method: "daemon.connection.probe",
    inputs: [
      cliInput("--endpoint", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-start",
    phase: "W3",
    path: ["daemon", "start", "--service"],
    summary: "Explicitly start the resident daemon.",
    method: "protocol.hello",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "daemon-status",
    phase: "W3",
    path: ["daemon", "status"],
    summary: "Show daemon and RepoCell status.",
    method: "daemon.status",
    inputs: [],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-create",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "create"],
    summary: "Create one machine-local runtime instance bound to a witnessed installation.",
    method: "daemon.runtimeInstance.create",
    inputs: [
      cliInput(
        "--id",
        "single",
        true,
        {
          code: "missing_field",
        },
        { regex: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      ),
      cliInput("--name", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--kind",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { enum: ["claude", "codex", "agy"] },
      ),
      cliInput("--installation", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--provider", "single", true, {
        code: "missing_field",
      }),
      cliInput("--model", "repeated", true, {
        code: "missing_field",
      }),
      cliInput("--default-model", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput(
        "--isolation",
        "single",
        false,
        {
          code: "invalid_runtime_isolation",
        },
        { enum: ["enforced", "operator-environment"] },
      ),
      cliInput("--effort", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput("--base-url", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--allow-insecure-http", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--wire-api", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--requires-openai-auth", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--http-header", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--credential-header", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--auth",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { enum: ["subscription", "api-key"] },
      ),
      cliInput(
        "--credential-ref",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: credentialReferenceRegex },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-github-credential-set",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "github-credential", "set", "<instance-id>"],
    positional: "instanceId",
    summary: "Bind a GitHub credential reference to an existing runtime instance.",
    method: "daemon.runtimeInstance.githubCredential.set",
    inputs: [
      cliInput(
        "--ref",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: credentialReferenceRegex },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-github-credential-unset",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "github-credential", "unset", "<instance-id>"],
    positional: "instanceId",
    summary: "Unbind the GitHub credential reference from an existing runtime instance.",
    method: "daemon.runtimeInstance.githubCredential.unset",
    inputs: [],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-list",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "list"],
    summary: [
      "List enabled runtime instances and currently witnessed installations ",
      "without secrets or host paths; use --all to include disabled instances.",
    ].join(""),
    method: "daemon.runtimeInstance.list",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-show",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "show", "<instance-id>"],
    positional: "instanceId",
    summary: "Show one redacted machine-local runtime instance; use --probe to verify provider authentication.",
    method: "daemon.runtimeInstance.show",
    inputs: [
      cliInput("--probe", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-delete",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "delete", "<instance-id>"],
    positional: "instanceId",
    summary: "Delete one runtime instance and any instance-managed state.",
    method: "daemon.runtimeInstance.delete",
    inputs: [],
  }),
  defineHostAdminCommand({
    id: "runtime-instance-update",
    phase: "Runtime-Instances-S1",
    path: ["runtime", "instance", "update", "<instance-id>"],
    positional: "instanceId",
    summary: [
      "Update a runtime instance's installation, metadata, models, permissions, ",
      "isolation, or enabled state without touching credentials.",
    ].join(""),
    method: "daemon.runtimeInstance.update",
    inputs: [
      cliInput("--name", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--installation", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--model", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--default-model", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--base-url", "single", false, {
        code: "invalid_base_url",
      }),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput(
        "--isolation",
        "single",
        false,
        {
          code: "invalid_runtime_isolation",
        },
        { enum: ["enforced", "operator-environment"] },
      ),
      cliInput("--enable", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--disable", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "runtime-instance-login",
    phase: "Runtime-Instances-S3",
    path: ["runtime", "instance", "login", "<instance-id>"],
    positional: "instanceId",
    summary: "Bridge your terminal to provider-native sign-in when supported by the runtime kind.",
    method: "repo.runtimeInstance.auth.login",
    inputs: [
      cliInput("--idempotency-key", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "runtime-instance-logout",
    phase: "Runtime-Instances-S3",
    path: ["runtime", "instance", "logout", "<instance-id>"],
    positional: "instanceId",
    summary: "Remove provider credentials through provider-native sign-out when supported by the runtime kind.",
    method: "repo.runtimeInstance.auth.logout",
    inputs: [
      cliInput("--idempotency-key", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
] as const);
