import { FACT_TYPE_VOCABULARY } from "../../entity-docs.ts";
import type { useFactFacetStats } from "../../entities-data.ts";

/**
 * Fact 详情专属的两个区块(dec_2935057783CD5D56E9F287AE4D CH1-CH3):Type 受控词表
 * 配置区与本仓实况。词表值来自 fact_domain_type 投影读面;空结果呈真实空态,
 * 禁止示例词冒充词表。从详情视图拆出后,视图本体只管两栏骨架。
 */

export function FactTypeVocabulary({ stats }: { readonly stats: ReturnType<typeof useFactFacetStats> }) {
  return (
    <section data-testid="fact-type-vocabulary" className="mt-6 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">Fact Type 受控词表</h3>
        <span className="rounded border border-accent/60 px-1.5 py-0.5 font-mono ui-micro text-accent">配置区</span>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-faint">投影实况</span>
      </div>
      <p className="mt-2 ui-meta leading-relaxed text-text-muted">
        裁决 {FACT_TYPE_VOCABULARY.decisionId}:Type 不允许自由文本——随手写会把「分面检索」退化成它要解决的 混乱。一个
        Type 值必须经一次显式登记才可使用;一条 fact 可同时归属多个 Type;已记录的 fact
        允许重新归类,以新事件表达并保留审计轨迹。
      </p>
      <div
        className="mt-3 rounded-md border border-dashed border-border px-3 py-3"
        data-testid="fact-type-registered-list"
      >
        <div className="font-mono ui-micro uppercase tracking-wide text-text-faint">已登记 Type</div>
        {stats.state === "pending" ? <p className="mt-1 ui-meta text-text-faint">正在读取已登记 Type…</p> : null}
        {stats.state === "error" ? <p className="mt-1 ui-meta text-status-blocked">Type 词表读取失败。</p> : null}
        {stats.state === "ready" && stats.domainTypes.length === 0 ? (
          <p className="mt-1 ui-meta leading-relaxed text-text-faint">
            空——本仓尚未登记 Fact Type。这里展示真实投影结果,不用示例词冒充词表。
          </p>
        ) : null}
        {stats.state === "ready" && stats.domainTypes.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {stats.domainTypes.map((entry) => (
              <li key={entry.domainType} className="flex items-center gap-2 ui-meta">
                <code className="font-mono text-text">{entry.domainType}</code>
                <span className="text-text-faint">由 fact/{entry.registeredByFactId} 登记</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function FactFacetLive({ stats }: { readonly stats: ReturnType<typeof useFactFacetStats> }) {
  return (
    <section data-testid="fact-facet-live" className="mt-4 border-t border-border pt-4">
      <h3 className="mb-2 ui-meta font-semibold uppercase tracking-wide text-text-muted">本仓实况</h3>
      {stats.state === "pending" && <p className="ui-meta text-text-faint">正在读取事实切面…</p>}
      {stats.state === "error" && <p className="ui-meta text-status-blocked">事实切面读取失败。</p>}
      {stats.state === "ready" && (
        <div className="flex flex-wrap items-center gap-2 ui-meta">
          <span className="font-mono text-text">{stats.total} 条 fact</span>
          {stats.byCategory.map((entry) => (
            <span
              key={entry.category}
              className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted"
            >
              {entry.category} · {entry.count}
            </span>
          ))}
        </div>
      )}
      {stats.state === "ready" && (
        <p className="mt-2 ui-micro leading-relaxed text-text-faint">
          来自既有 facts 切面读(与 ⌘K 面板同一条,共享缓存)。category 是 memoryClass 在读面上的折叠:
          semantic→lesson、procedural→progress、episodic→finding。Type 轴的分布等登记面合入后在此并列。
        </p>
      )}
    </section>
  );
}
