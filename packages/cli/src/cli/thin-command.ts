export const thinCliLocalErrorCodes = Object.freeze([
  "daemon_disconnect",
  "daemon_target_conflict",
  "duplicate_field",
  "invalid_field",
  "missing_field",
  "unknown_field",
  "unsupported_command",
]);

export { deriveCliCapabilities } from "./thin-command-help.ts";
export { runtimeBatchDeclarationFields } from "./thin-command-help.ts";
export { runtimeRunEfforts } from "./thin-command-help.ts";
export { renderThinCapabilities } from "./thin-command-help.ts";
export { firstCliCommandIndex } from "./thin-command-help.ts";
export { firstCliCommand } from "./thin-command-help.ts";
export { helpDomain } from "./thin-command-help.ts";
export { deriveThinCliInputs } from "./thin-command-inputs.ts";
export { parseThinCommand } from "./thin-command-router.ts";
export { cliCommandDomains } from "./thin-command-help.ts";
export { unsupportedCommandHint } from "./thin-command-help.ts";
export type { ThinHelpCatalogEntry } from "./thin-command-help.ts";
export type { ThinCommand } from "./thin-command-types.ts";
export type { ThinParseResult } from "./thin-command-types.ts";
export type { ThinCliInput } from "./thin-command-types.ts";

import { thinCliCommands } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { commandDomains } from "./thin-command-help.ts";
import type { ThinHelpCatalogEntry } from "./thin-command-help.ts";

export function renderThinHelp(
  catalog: readonly ThinHelpCatalogEntry[] = [],
  domain?: string,
): string {
  const rows = [
      ...thinCliCommands.map(({ usage, summary, help }) => ({
        usage,
        summary,
        help,
      })),
    ],
    visible = domain
      ? rows.filter(({ usage }) => usage.split(" ")[1] === domain)
      : rows,
    groups = commandDomains(),
    body = domain
      ? [
          `Commands for ${domain}:`,
          ...visible.map(
            ({ usage, summary, help }) =>
              `  ${usage}\n    ${summary}${help ? `\n${help}` : ""}`,
          ),
        ]
      : [
          "Commands:",
          ...groups.map(
            ({ name, count }) =>
              `  ${name} (${count} command${count === 1 ? "" : "s"})`,
          ),
          "",
          "Meta:",
          "  capabilities [--json] — Describe the contracted CLI command surface.",
          "  --version — Print the CLI package version.",
          "",
          "Use ha <domain> --help for the commands in a domain.",
          ...rows
            .filter(({ usage }) => usage.includes("--service"))
            .map(({ usage }) => `  ${usage}`),
        ],
    presetRows = catalog.length
      ? ["", "Recommended presets:", ...catalog.map(renderPresetHelpEntry)]
      : [];
  return ["Harness Anything thin CLI", "", ...body, ...presetRows].join("\n");
}

function renderPresetHelpEntry(entry: ThinHelpCatalogEntry): string {
  const description =
    entry.validity === "valid"
      ? entry.description
      : `${entry.validity}${entry.errorCode ? ` (${entry.errorCode})` : ""}`;
  return `  ${entry.id} — ${entry.title} — ${description}`;
}
