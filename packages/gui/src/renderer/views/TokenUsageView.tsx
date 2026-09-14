import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AgentRuntimeTokenUsageAgentRow,
  AgentRuntimeTokenUsageSquadRow,
} from "../../../../daemon/src/agent-runtime-token-usage.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { t } from "../i18n/index.tsx";
import { Badge, Empty, SegCtl } from "../components/runtime/parts.tsx";
import { QUERY_PACING_MS } from "../query-pacing.ts";
import { compactTokens, exactTokens } from "../token-format.ts";

/**
 * 系统 Tab 的「Token 消耗」页(PLT-Observability-Eval P1.3,泽宇 2026-09-14 定形):
 * 按 Agent 聚合「今天」的派工消耗——会话数、输入/缓存读取/输出/总 Token 与工具调用,
 * 同页可切小队视图(单 Worker 优先,小队排后)。数据是 daemon 侧一条聚合读
 * (repo.agentRuntime.tokenUsage):窗口(daemon 本地零点)与聚合都在 daemon 完成,
 * renderer 不拉全量派工再聚合。
 */
type Segment = "agents" | "squads";

const REPO_ID = /^[a-z][a-z0-9-]{0,62}$/u;

export function TokenUsageView({ repoId }: { readonly repoId: string }) {
  const [segment, setSegment] = useState<Segment>("agents");
  const usage = useQuery({
    queryKey: runtimeQueryKeys.tokenUsageAll(repoId),
    queryFn: () => agentRuntimeClient.tokenUsage(repoId),
    enabled: REPO_ID.test(repoId),
    // 派工流的 runtime_metrics 增长不推进台账 cut,页面自持低频轮询(见 query-pacing)。
    refetchInterval: QUERY_PACING_MS.tokenUsage,
  });
  return (
    <section data-testid="token-usage-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
        <b className="ui-body tracking-[0.02em]">{t("agentRuntime.tokenUsageTitle")}</b>
        <SegCtl
          label={t("agentRuntime.tokenUsageSegmentLabel")}
          value={segment}
          onChange={(value) => setSegment(value)}
          options={[
            { value: "agents", label: t("agentRuntime.tokenUsageSegmentAgents") },
            { value: "squads", label: t("agentRuntime.tokenUsageSegmentSquads") },
          ]}
        />
        <span className="flex-1" />
        <Badge tip={usage.data?.since}>{t("agentRuntime.tokenUsageRangeToday")}</Badge>
      </header>
      {usage.isError ? (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-micro
        text-status-blocked"
        >
          {t("agentRuntime.readFailed", {
            error: usage.error instanceof Error ? usage.error.message : String(usage.error),
          })}
        </p>
      ) : null}
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
        {usage.isPending ? (
          <Empty>{t("agentRuntime.loading")}</Empty>
        ) : segment === "agents" ? (
          <UsageTable
            testId="token-usage-agents-table"
            rows={usage.data?.agents ?? []}
            idOf={(row) => row.agentId}
            nameOf={(row) => row.agentName}
          />
        ) : (
          <UsageTable
            testId="token-usage-squads-table"
            rows={usage.data?.squads ?? []}
            idOf={(row) => row.squadId}
            nameOf={(row) => row.squadName}
          />
        )}
      </main>
    </section>
  );
}

function UsageTable<T extends AgentRuntimeTokenUsageAgentRow | AgentRuntimeTokenUsageSquadRow>({
  testId,
  rows,
  idOf,
  nameOf,
}: {
  readonly testId: string;
  readonly rows: readonly T[];
  readonly idOf: (row: T) => string;
  readonly nameOf: (row: T) => string;
}) {
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  return (
    <table data-testid={testId} className="w-full border-separate border-spacing-0">
      <thead>
        <tr className="text-left font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColName")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColSessions")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColInput")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColCacheRead")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColOutput")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColTotal")}</th>
          <th className="border-b border-border pb-1 text-right">{t("agentRuntime.tokenUsageColTools")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={idOf(row)} data-testid={`token-usage-row-${idOf(row)}`} className="hover:bg-surface-raised">
            <td className="border-b border-border py-1 pr-3 ui-micro">
              <span className="font-[550]">{nameOf(row)}</span>
              <span className="ml-1.5 font-mono text-text-faint">{idOf(row)}</span>
            </td>
            <td className="border-b border-border py-1 pr-3 text-right font-mono ui-micro">{row.sessionCount}</td>
            <NumberCell value={row.inputTokens} />
            <NumberCell value={row.cacheReadTokens} />
            <NumberCell value={row.outputTokens} />
            <NumberCell value={row.totalTokens} emphasized />
            <td className="border-b border-border py-1 text-right font-mono ui-micro">{row.toolCallCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NumberCell({ value, emphasized = false }: { readonly value: number; readonly emphasized?: boolean }) {
  return (
    <td
      title={exactTokens(value)}
      className={`border-b border-border py-1 pr-3 text-right font-mono ui-micro ${emphasized ? "font-semibold" : ""}`}
    >
      {compactTokens(value)}
    </td>
  );
}
