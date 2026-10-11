import type { AgentRuntimeTokenUsageTotals } from "@harness-anything/daemon/protocol";
import { cacheWriteCaveat, usageIsUnreported } from "../../token-usage-model.ts";
import { exactTokens, preciseTokens } from "../../token-format.ts";
import { t } from "../../i18n/index.tsx";

type CacheWriteRow = Pick<
  AgentRuntimeTokenUsageTotals,
  | "cacheWriteTokens"
  | "usageReportedDispatches"
  | "usageUnavailableDispatches"
  | "cacheWriteUnreportedDispatches"
  | "cacheWriteUnitemizedDispatches"
>;

/** Every numeric cache-write surface carries its own evidence, including mixed rows. */
export function CacheWriteValue({ row, exact = false }: { readonly row: CacheWriteRow; readonly exact?: boolean }) {
  const caveat = cacheWriteCaveat(row);
  if (usageIsUnreported(row)) return <span>{t("agentRuntime.sessionMetricsUnavailable")}</span>;
  if (caveat !== null) return <span title={t("agentRuntime.tokenUsageCacheWriteNote")}>{t(caveat)}</span>;
  return (
    <span>
      <span title={exactTokens(row.cacheWriteTokens)}>
        {(exact ? exactTokens : preciseTokens)(row.cacheWriteTokens)}
      </span>
      {row.cacheWriteUnreportedDispatches > 0 ? (
        <span className="ml-1 font-sans ui-meta text-text-muted">
          {t("agentRuntime.tokenUsageCacheWriteMixedUnreported", { count: String(row.cacheWriteUnreportedDispatches) })}
        </span>
      ) : null}
      {row.cacheWriteUnitemizedDispatches > 0 ? (
        <span className="ml-1 font-sans ui-meta text-text-muted">
          {t("agentRuntime.tokenUsageCacheWriteMixedUnitemized", { count: String(row.cacheWriteUnitemizedDispatches) })}
        </span>
      ) : null}
    </span>
  );
}
