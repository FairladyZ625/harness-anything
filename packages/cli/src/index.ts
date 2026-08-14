#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCliCapabilities, firstCliCommand, helpDomain, parseThinCommand, renderThinCapabilities, renderThinHelp } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = firstCliCommand(argv); if (argv.includes("--version") || argv.includes("-v") || command === "version") return emitMeta("version", argv.includes("--json")); if (command === "capabilities") return emitMeta("capabilities", argv.includes("--json"));
  if (argv.length === 0 || argv.includes("--help")) { const rows = await taskCreateHelpCatalog(argv), domain = helpDomain(argv); console.log(rows.length === 0 && domain === undefined ? renderThinHelp() : renderThinHelp(rows, domain)); return 0; }
  if (argv.includes("daemon")) { const { runDaemonControl } = await import("./daemon/control.ts"); return runDaemonControl(argv); }
  const parsed = parseThinCommand(argv);
  if (!parsed.ok) { emit(cliFailure("parse", parsed.code, parsed.nextAction), parsed.json); return 2; }
  try { const receipt = await runCommandThroughDaemon(parsed.command, (phase) => emit(phase, parsed.command.json)); emit(receipt, parsed.command.json); return Number.isInteger(receipt.exitCode) ? Number(receipt.exitCode) : receipt.ok === true ? 0 : 1; } catch (error) { emit(cliFailure(parsed.command.action.kind, "daemon_unavailable", `Start the explicit daemon and retry. Cause: ${error instanceof Error ? error.message : String(error)}`), parsed.command.json); return 1; }
}

export function resolveCliVersion(): string { let dir = path.dirname(fileURLToPath(import.meta.url)); for (let depth = 0; depth < 8; depth += 1) { const candidate = path.join(dir, "package.json"); if (existsSync(candidate)) { const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { readonly name?: unknown; readonly version?: unknown }; if (pkg.name === "@harness-anything/cli" && typeof pkg.version === "string") return pkg.version; } const parent = path.dirname(dir); if (parent === dir) break; dir = parent; } throw new Error("CLI version could not be derived from package.json."); }
function emitMeta(command: "version" | "capabilities", json: boolean): number { if (command === "capabilities") { const capabilities = deriveCliCapabilities(); console.log(json ? JSON.stringify(capabilities) : renderThinCapabilities()); return 0; } const version = resolveCliVersion(); console.log(json ? JSON.stringify({ ok: true, command, version }) : version); return 0; }

async function taskCreateHelpCatalog(argv: readonly string[]): Promise<Array<{ id: string; title: string; description: string; validity: string; errorCode?: string }>> { if (argv[0] !== "task" || argv[1] !== "create") return []; const globals = argv.flatMap((value, index) => value === "--json" ? [value] : value === "--root" || value === "--repo" ? [value, argv[index + 1] ?? ""] : []), parsed = parseThinCommand(["preset", "list", ...globals]); if (!parsed.ok) return []; try { const receipt = await runCommandThroughDaemon(parsed.command), rows = typeof receipt.evidence === "string" ? JSON.parse(receipt.evidence) as unknown : null; return Array.isArray(rows) ? rows.filter((row): row is { id: string; title: string; description: string; validity: string; errorCode?: string } => !!row && typeof row === "object" && ["id", "title", "description", "validity"].every((key) => typeof (row as Record<string, unknown>)[key] === "string")) : []; } catch { return []; } }
function cliFailure(command: string, code: string, nextAction: string): Record<string, unknown> { return { schema: "command-receipt/v2", ok: false, command, outcome: "rejected", opId: "N/A", origin: "cli", code, evidence: `rejection:${code}`, error: { code, hint: nextAction }, nextAction }; }
function emit(receipt: Record<string, unknown>, json: boolean): void {
  if (json) console.log(JSON.stringify(receipt));
  else if (receipt.ok === true || receipt.command === "migrate-import" && typeof receipt.summary === "string") console.log(String(receipt.command === "doc-show" ? receipt.evidence : receipt.command === "init" ? [String(receipt.summary), `outcome: ${receipt.outcome ?? "applied"}`, ...["created", "updated", "preserved", "drifted"].map((key) => `${key}: ${JSON.stringify(receipt[key] ?? [])}`), `commit: ${String(receipt.commit ?? "none")}`, `next: ${String(receipt.next ?? "")}`].join("\n") : receipt.summary ?? `${receipt.command ?? "command"}: ${receipt.outcome ?? "applied"}`));
  else console.error(`error code=${String((receipt.error as { code?: unknown } | undefined)?.code ?? "unknown")} hint=${String(receipt.nextAction ?? receipt.next ?? "Command failed.")}`);
}
function isCliEntrypoint(): boolean { const invoked = process.argv[1]; if (!invoked) return false; try { return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url)); } catch { return invoked.endsWith("packages/cli/src/index.ts"); } }
if (isCliEntrypoint()) process.exitCode = await main();
