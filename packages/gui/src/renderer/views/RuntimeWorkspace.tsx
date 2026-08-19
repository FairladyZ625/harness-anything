import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentRuntimeClient } from "../agent-runtime-client.ts";
import { runtimeCommandClient } from "../runtime-command-client.ts";
import { submitRuntimeSpawn, type RuntimeSpawnInput, type RuntimeSpawnSettlement } from "../runtime-control.ts";
import { RuntimeControlPanel } from "../components/RuntimeControlPanel.tsx";
import { RuntimeInstanceManager } from "../components/RuntimeInstanceManager.tsx";
import { EntityLayersPanel } from "../components/EntityLayersPanel.tsx";
import { AgentRuntimeView } from "./agent-runtime-view.tsx";
import { t } from "../i18n/index.tsx";

export function RuntimeWorkspace({ repoId, tasks }: { readonly repoId: string; readonly tasks: readonly { readonly taskId: string; readonly title: string }[] }) {
  const queryClient = useQueryClient(), key = ["runtime-control", repoId, "overview"] as const, overview = useQuery({ queryKey: key, queryFn: () => agentRuntimeClient.overview(repoId), staleTime: 3_000 });
  const [busy, setBusy] = useState(false), [settlement, setSettlement] = useState<RuntimeSpawnSettlement | null>(null), [revision, setRevision] = useState(0), [error, setError] = useState<string | null>(null);
  const reread = async () => { await queryClient.fetchQuery({ queryKey: key, queryFn: () => agentRuntimeClient.overview(repoId), staleTime: 0 }); setRevision((value) => value + 1); };
  const spawn = async (input: RuntimeSpawnInput) => { if (busy) return; setBusy(true); setSettlement(null); setError(null); try { const result = await submitRuntimeSpawn(input, { spawn: (payload) => runtimeCommandClient.spawn(repoId, payload), showReceipt: (opId) => runtimeCommandClient.showReceipt(repoId, opId), overview: () => agentRuntimeClient.overview(repoId), onPending: setSettlement }); setSettlement(result); await reread(); } catch (cause) { consumeKnownError(cause); setError(message(cause)); } finally { setBusy(false); } };
  if (overview.isError) return <section className="p-6 text-status-blocked">{t("views.agentRuntimeView.runtimeReadFailed", { error: message(overview.error) })}</section>;
  if (!overview.data) return <section className="p-6 text-text-faint">{t("views.agentRuntimeView.loadingRuntimeProjection")}</section>;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><div className="max-h-[62dvh] shrink-0 overflow-y-auto"><RuntimeInstanceManager repoId={repoId}/><EntityLayersPanel repoId={repoId}/>{error && <p role="alert" className="border-b border-border bg-status-blocked/10 px-4 py-2 text-xs text-status-blocked">{error}</p>}<RuntimeControlPanel overview={overview.data} tasks={tasks} busy={busy} settlement={settlement} onSpawn={spawn}/></div><AgentRuntimeView key={`${repoId}:${revision}`} repoId={repoId}/></div>;
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function consumeKnownError(value: unknown): void { void value; }
