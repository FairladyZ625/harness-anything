import { useMemo, useState } from "react";
import { Plus, Robot } from "@phosphor-icons/react";
import { BTN } from "../components/ui/widgets.tsx";
import { useToast } from "../components/MutationToast.tsx";
import { t } from "../i18n/index.tsx";
import {
  useAgentRuntimeStatusQuery,
  useSpawnAgentRuntimeMutation,
  type AgentRuntimeSessionStatus
} from "../agent-runtime-data.ts";
import { shortId } from "../components/agent-runtime/helpers.ts";
import { AgentRuntimeSessionList } from "../components/agent-runtime/AgentRuntimeSessionList.tsx";
import { AgentRuntimeSessionDetail } from "../components/agent-runtime/AgentRuntimeSessionDetail.tsx";
import { AgentRuntimeConfigPanel } from "../components/agent-runtime/AgentRuntimeConfigPanel.tsx";
import { AgentRuntimeSpawnModal } from "../components/agent-runtime/AgentRuntimeSpawnModal.tsx";

/**
 * Agent Runtime 控制台:session 列表 + 单 session detail(events) + credentials 配置面。
 *
 * 数据流:status 列表 2s 轮询;events 1.5s 轮询(选中 session 时);profiles 15s stale。
 * spawn 走 mutation,成功后 invalidate status 列表。
 */
export function AgentRuntimeView({ repoId }: { readonly repoId?: string | null }) {
  const statusQuery = useAgentRuntimeStatusQuery(repoId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const showToast = useToast();
  const spawnMutation = useSpawnAgentRuntimeMutation(repoId);

  const sessions = statusQuery.data ?? [];
  const selected = useMemo(
    () => sessions.find((session) => session.runtimeSessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const handleSpawn = (payload: Parameters<typeof spawnMutation.mutate>[0]) => {
    spawnMutation.mutate(payload, {
      onSuccess: (session: AgentRuntimeSessionStatus) => {
        setSpawnOpen(false);
        setSelectedSessionId(session.runtimeSessionId);
        showToast(t("views.agentRuntimeView.spawnSucceeded", { id: shortId(session.runtimeSessionId) }), "success");
      },
      onError: (error: Error) => showToast(t("views.agentRuntimeView.spawnFailed", { error: error.message }), "error")
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Robot weight="duotone" className="text-xl text-text-muted" />
        <div className="min-w-0 flex-1">
          <h1 className="ui-title font-mono font-semibold">{t("views.agentRuntimeView.title")}</h1>
          <p className="ui-meta mt-0.5 text-text-faint">{t("views.agentRuntimeView.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setSpawnOpen(true)}
          className={BTN}
          title={t("views.agentRuntimeView.newSession")}
        >
          <span className="inline-flex items-center gap-1.5">
            <Plus weight="bold" className="text-[12px]" />
            {t("views.agentRuntimeView.newSession")}
          </span>
        </button>
      </header>

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex min-w-0 flex-col gap-4">
          <AgentRuntimeSessionList
            sessions={sessions}
            loading={statusQuery.isLoading && sessions.length === 0}
            failed={statusQuery.isError}
            errorMessage={statusQuery.error instanceof Error ? statusQuery.error.message : undefined}
            selectedId={selectedSessionId}
            onSelect={setSelectedSessionId}
          />
          <AgentRuntimeSessionDetail session={selected} repoId={repoId} />
        </section>
        <AgentRuntimeConfigPanel repoId={repoId} />
      </div>

      {spawnOpen && (
        <AgentRuntimeSpawnModal
          onClose={() => setSpawnOpen(false)}
          onSubmit={handleSpawn}
          pending={spawnMutation.isPending}
        />
      )}
    </div>
  );
}
