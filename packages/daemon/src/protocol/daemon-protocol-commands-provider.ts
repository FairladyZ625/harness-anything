import { cliInput, defineHostAdminCommand } from "@harness-anything/preset/internal/preset-command-contract";

const credentialReferenceRegex =
  "^credential:v1:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$|^keychain:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$";

export const providerProtocolCommands = Object.freeze([
  defineHostAdminCommand({
    id: "provider-create",
    phase: "Decision-Provider",
    path: ["provider", "create"],
    summary: "Create a machine-local Decisions provider. Only --type decisions is supported.",
    method: "daemon.provider.create",
    inputs: [
      cliInput("--type", "single", true, { code: "missing_field" }, { enum: ["decisions"] }),
      cliInput("--id", "single", true, { code: "missing_field" }, { regex: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
      cliInput("--name", "single", true, { code: "missing_field" }),
      cliInput("--vendor", "single", false, { code: "invalid_field" }, { enum: ["openrouter"] }),
      cliInput("--model", "single", true, { code: "missing_field" }),
      cliInput("--base-url", "single", false, { code: "invalid_field" }),
      cliInput("--api-key-file", "single", false, { code: "invalid_field" }, { conflictsWith: ["--credential-ref"] }),
      cliInput(
        "--credential-ref",
        "single",
        false,
        { code: "invalid_field" },
        { regex: credentialReferenceRegex, conflictsWith: ["--api-key-file"] },
      ),
      cliInput("--disabled", "boolean", false, { code: "invalid_field" }),
    ],
  }),
  defineHostAdminCommand({
    id: "provider-list",
    phase: "Decision-Provider",
    path: ["provider", "list"],
    summary: "List machine-local Decisions providers without exposing credentials.",
    method: "daemon.provider.list",
    inputs: [],
  }),
  ...(["show", "probe", "delete"] as const).map((operation) =>
    defineHostAdminCommand({
      id: `provider-${operation}`,
      phase: "Decision-Provider",
      path: ["provider", operation, "<provider-id>"],
      positional: "providerId",
      summary:
        operation === "show"
          ? "Show one redacted Decisions provider."
          : operation === "probe"
            ? "Verify one Decisions provider can reach OpenRouter."
            : "Delete one Decisions provider and remove its unused credential.",
      method: `daemon.provider.${operation}`,
      inputs: [],
    }),
  ),
  defineHostAdminCommand({
    id: "provider-update",
    phase: "Decision-Provider",
    path: ["provider", "update", "<provider-id>"],
    positional: "providerId",
    summary: "Update a Decisions provider configuration.",
    method: "daemon.provider.update",
    inputs: [
      cliInput("--name", "single", false, { code: "invalid_field" }),
      cliInput("--model", "single", false, { code: "invalid_field" }),
      cliInput("--base-url", "single", false, { code: "invalid_field" }),
      cliInput("--clear-base-url", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--base-url"] }),
      cliInput("--api-key-file", "single", false, { code: "invalid_field" }, { conflictsWith: ["--credential-ref"] }),
      cliInput(
        "--credential-ref",
        "single",
        false,
        { code: "invalid_field" },
        { regex: credentialReferenceRegex, conflictsWith: ["--api-key-file"] },
      ),
      cliInput("--enable", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--disable"] }),
      cliInput("--disable", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--enable"] }),
    ],
  }),
] as const);
