import { parseVerticalScriptResult, sha256Text, type ActorIdentity, type CanonicalEventStore, type EventPublicationKillpoint, type TaskProjection, type VerticalScriptResultV1, type WriteReceipt, type WriteSource } from "../../kernel/src/index.ts";
import { acceptBuiltinVerticalScriptPlan, prepareBuiltinVerticalScriptExecution } from "../../preset/src/index.ts";
import { publishVerticalScriptChanges } from "./doc-sync-actions.ts";
import { runProcessTextAsync } from "./process-port.ts";

type Input = { readonly action: unknown; readonly binding: { readonly actor: ActorIdentity; readonly source: WriteSource; readonly docWriteAllowed?: boolean }; readonly workspaceId: string; readonly rootDir: string; readonly store: CanonicalEventStore; readonly projection: TaskProjection; readonly now: () => string; readonly killpoint?: (point: EventPublicationKillpoint) => void };
export async function runVerticalScriptAction(input: Input): Promise<WriteReceipt> {
  const prepared = prepareBuiltinVerticalScriptExecution({ rootDir: input.rootDir, action: input.action, commitSha: input.store.currentCommit().sha }), blocker = process.env.HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE;
  const testPermissions = blocker ? [`--allow-fs-read=${blocker}`, `--allow-fs-write=${blocker}.started`] : [], childEnvironment = { PATH: process.env.PATH, ...(blocker ? { HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker } : {}) };
  const stdout = await runProcessTextAsync(process.execPath, ["--permission", ...prepared.readRoots.map((root) => `--allow-fs-read=${root}/*`), ...testPermissions, prepared.command, prepared.contextArgument], input.rootDir, childEnvironment);
  const plan = acceptBuiltinVerticalScriptPlan(prepared, stdout);
  if (!plan.ok) throw verticalScriptActionError("script_reported_failure", `${plan.status}: ${JSON.stringify(plan.report)}`);
  const result = scriptResult(prepared.action.dryRun, plan);
  if (prepared.action.dryRun || !plan.changes.length) return { outcome: "applied", opId: `script:${result.planDigest}`, revision: input.store.readHead()?.revision ?? 0, evidence: JSON.stringify(result), visibility: "center", proof: { committedRevision: input.store.readHead()?.revision ?? 0, appliedCut: input.projection.list().watermark, durable: true, canonicalVisible: true, worktreeVisible: false } };
  const receipt = publishVerticalScriptChanges({ ...input }, prepared.action, plan.changes); return receipt.outcome === "applied" || receipt.outcome === "pending" ? { ...receipt, evidence: JSON.stringify(result) } : receipt;
}
function scriptResult(dryRun: boolean, plan: ReturnType<typeof acceptBuiltinVerticalScriptPlan>): VerticalScriptResultV1 { return parseVerticalScriptResult({ schema: "vertical-script-result/v1", scriptId: plan.scriptId, mode: dryRun ? "dry-run" : "apply", ok: plan.ok, status: plan.status, report: plan.report, warnings: plan.warnings, documents: plan.changes.map(({ path, body, mediaType, disposition }) => ({ path, sha256: `sha256:${sha256Text(body)}`, size: Buffer.byteLength(body), mediaType, disposition })), planDigest: `sha256:${sha256Text(JSON.stringify(plan))}` }); }
function verticalScriptActionError(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
