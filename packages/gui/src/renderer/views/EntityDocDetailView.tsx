import { ArrowLeft, ArrowSquareOut, CaretRight } from "@phosphor-icons/react";
import { entityDocIndex, FACT_TYPE_VOCABULARY, type EntityFieldDoc, type EntityKindDoc } from "../entity-docs.ts";
import { useEntityKindCatalog } from "../entity-kind-data.ts";
import { findEntityKind, type EntityKindDeclaration } from "../entity-kind-catalog-client.ts";
import { GovernedEntityPanel } from "../components/entityDoc/GovernedEntityPanel.tsx";
import type { ViewId } from "../navigation/viewHistory.ts";
import { useFactFacetStats, type EntityLiveCounts } from "../entities-data.ts";

/**
 * 实体说明面·详情:一个实体是什么、字段什么含义、状态词表、与谁有什么关系、
 * 合法写入动作。与 PresetDetailView 同构(面包屑头部 + 回撤原路返回)。
 * Fact 详情额外承载 Type 受控词表配置区(dec_2935057783CD5D56E9F287AE4D):
 * 词表由既有 facts 切面读返回;空结果呈真实空态,禁止示例词冒充词表。
 */
export function EntityDocDetailView({
  repoId,
  kind,
  selectedEntityRef,
  liveCounts,
  projectName,
  fromViewLabel,
  onBack,
  onOpenView,
}: {
  readonly repoId: string;
  readonly kind: string;
  /** 声明实体的深链接落点(`<kind>/<entityId>`);null = 只看说明。 */
  readonly selectedEntityRef: string | null;
  readonly liveCounts: EntityLiveCounts;
  readonly projectName: string;
  readonly fromViewLabel: string;
  readonly onBack: () => void;
  readonly onOpenView: (view: ViewId) => void;
}) {
  const { catalog } = useEntityKindCatalog(repoId);
  const doc = entityDocIndex(catalog).get(kind) ?? null;
  const catalogRow = findEntityKind(catalog, kind);
  const factStats = useFactFacetStats(repoId, kind === "fact");
  if (doc === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="entity-doc-detail-unknown">
        <header className="border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={onBack}
            className={[
              "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 ui-meta text-text-muted",
              "hover:border-border-strong hover:text-text",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" />
            {fromViewLabel}
          </button>
        </header>
        <p className="p-6 ui-body text-status-blocked">
          未知实体 kind:{kind}。说明目录只收录已登记的实体,不猜测未登记的种类。
        </p>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid={`entity-doc-detail-${doc.kind}`}>
      <header className="shrink-0 border-b border-border px-4 py-3" data-testid="entity-doc-detail-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回上一级"
            className={[
              "grid size-7 shrink-0 place-items-center rounded-md border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 font-mono ui-micro leading-3 text-text-faint">
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                {projectName}
              </button>
              <CaretRight weight="bold" className="shrink-0" />
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                {fromViewLabel}
              </button>
              <CaretRight weight="bold" className="shrink-0" />
              <span className="truncate font-mono ui-micro leading-3 text-text-muted">{doc.kind}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="truncate font-mono ui-title font-semibold leading-5 tracking-[-0.01em] text-text">
                {doc.kind}
              </h1>
              {doc.schemaId && <DocBadge value={doc.schemaId} />}
              {doc.refTemplate && <DocBadge value={doc.refTemplate} />}
              <LiveCountBadge doc={doc} liveCounts={liveCounts} />
            </div>
          </div>
          {doc.guiEntry && (
            <button
              type="button"
              onClick={() => onOpenView(doc.guiEntry!.view)}
              title={doc.guiEntry.note}
              className={[
                "inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 ui-meta",
                "text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text",
              ].join(" ")}
            >
              <ArrowSquareOut />
              看实况
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 px-4 py-4" data-testid="entity-doc-detail-content">
        <section className="max-w-3xl">
          <p className="ui-body leading-relaxed text-text">{doc.definition}</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 ui-meta">
            <dt className="font-mono ui-micro uppercase tracking-wide text-text-faint">存放</dt>
            <dd className="text-text-muted">{doc.storage}</dd>
            {doc.guiEntry && (
              <>
                <dt className="font-mono ui-micro uppercase tracking-wide text-text-faint">GUI 入口</dt>
                <dd className="text-text-muted">{doc.guiEntry.note}</dd>
              </>
            )}
            {!doc.guiEntry && (
              <>
                <dt className="font-mono ui-micro uppercase tracking-wide text-text-faint">GUI 入口</dt>
                <dd className="text-text-muted">当前没有专页;写入走 CLI,如实标注不硬造入口。</dd>
              </>
            )}
          </dl>
        </section>

        <DetailSection title="核心字段" testId="entity-doc-fields">
          <FieldTable fields={doc.fields} />
          {doc.nestedFields.map((nested) => (
            <div key={nested.container} className="mt-3">
              <h4 className="mb-1.5 font-mono ui-micro uppercase tracking-wide text-text-faint">{nested.container}</h4>
              <FieldTable fields={nested.fields} />
            </div>
          ))}
        </DetailSection>

        {doc.statuses.length > 0 && (
          <DetailSection title="状态词表" testId="entity-doc-statuses">
            {doc.statuses.map((status) => (
              <div key={status.field} className="mb-2 last:mb-0">
                <code className="font-mono ui-micro text-text-muted">{status.field}</code>
                <div className="mt-1 flex flex-wrap gap-1">
                  {status.words.map((word) => (
                    <span
                      key={word}
                      data-testid={`entity-status-word-${word}`}
                      className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted"
                    >
                      {word}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <p className="mt-2 ui-micro leading-relaxed text-text-faint">
              词表逐字来自内核注册表;这里的每个词都是合法值,不在词表里的状态写不进台账。
            </p>
          </DetailSection>
        )}

        {doc.edges.length > 0 && (
          <DetailSection title="关系" testId="entity-doc-relations">
            <ul className="space-y-1">
              {doc.edges.map((edge) => (
                <li
                  key={`${edge.sourceKind}-${edge.type}-${edge.targetKind}`}
                  className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono ui-micro"
                >
                  <span className={edge.sourceKind === doc.kind ? "font-semibold text-text" : "text-text-muted"}>
                    {edge.sourceKind}
                  </span>
                  <span className="text-text-faint">--</span>
                  <span className="rounded bg-surface-raised px-1.5 py-0.5 text-accent">{edge.type}</span>
                  <span className="text-text-faint">--&gt;</span>
                  <span className={edge.targetKind === doc.kind ? "font-semibold text-text" : "text-text-muted"}>
                    {edge.targetKind}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 ui-micro leading-relaxed text-text-faint">
              加粗端是本实体。方向注册表规定哪种(源, 动词, 目标)三元组合法;未注册的组合写不进台账。
            </p>
          </DetailSection>
        )}

        {doc.actions.length > 0 && (
          <DetailSection title="合法写入动作" testId="entity-doc-actions">
            <div className="flex flex-wrap gap-1">
              {doc.actions.map((action) => (
                <span
                  key={action}
                  className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted"
                >
                  {action}
                </span>
              ))}
            </div>
            <p className="mt-2 ui-micro leading-relaxed text-text-faint">
              动作目录来自内核;不在此列的写入路径不存在。GUI 是视图消费者,写操作与 CLI 同面。
            </p>
          </DetailSection>
        )}

        {doc.kind === "fact" && <FactTypeVocabulary stats={factStats} />}
        {doc.kind === "fact" && <FactFacetLive stats={factStats} />}
        {catalogRow !== null && catalogRow.origin === "vertical" && (
          <div className="mt-6 max-w-3xl border-t border-border pt-4">
            <GovernedEntityPanel repoId={repoId} row={catalogRow} selectedEntityRef={selectedEntityRef} />
          </div>
        )}
        {catalogRow?.declaration != null && <DeclarationFacets declaration={catalogRow.declaration} />}
      </main>
    </div>
  );
}

function DetailSection({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} className="mt-6 max-w-3xl border-t border-border pt-4">
      <h3 className="mb-2 ui-meta font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

function FieldTable({ fields }: { readonly fields: readonly EntityFieldDoc[] }) {
  return (
    <table className="w-full border-collapse ui-meta">
      <thead>
        <tr className="border-b border-border text-left font-mono ui-micro uppercase tracking-wide text-text-faint">
          <th className="py-1 pr-3 font-normal">字段</th>
          <th className="py-1 pr-3 font-normal">必填</th>
          <th className="py-1 pr-3 font-normal">形状</th>
          <th className="py-1 font-normal">含义</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.name} className="border-b border-border/60 align-top">
            <td className="py-1.5 pr-3 font-mono ui-micro text-text">{field.name}</td>
            <td className="py-1.5 pr-3 font-mono ui-micro">
              {field.required ? (
                <span className="text-accent">必填</span>
              ) : (
                <span className="text-text-faint">可选</span>
              )}
            </td>
            <td className="py-1.5 pr-3 font-mono ui-micro text-text-faint">{field.shape}</td>
            <td className="py-1.5 leading-relaxed text-text-muted">{field.meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocBadge({ value }: { readonly value: string }) {
  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted">
      {value}
    </span>
  );
}

function LiveCountBadge({ doc, liveCounts }: { readonly doc: EntityKindDoc; readonly liveCounts: EntityLiveCounts }) {
  if (doc.liveCount === null) return null;
  const live = liveCounts[doc.liveCount];
  const label = live.state === "ready" ? `本仓 ${live.count} 条` : live.state === "error" ? "读取失败" : "读取中…";
  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted">
      {label}
    </span>
  );
}

/**
 * Fact Type 受控词表配置区(本面第一个可配置项)。裁决 dec_2935057783CD5D56E9F287AE4D:
 * Type 必须显式登记后可用(CH1,不允许自由文本)、一条 fact 可属多个 Type(CH2)、
 * 已记录的 fact 可重新归类且保留审计轨迹(CH3)。登记面后端未合入,这里呈真实空态。
 */
function FactTypeVocabulary({ stats }: { readonly stats: ReturnType<typeof useFactFacetStats> }) {
  return (
    <section
      data-testid="fact-type-vocabulary"
      className="mt-6 max-w-3xl rounded-lg border border-border bg-surface p-4"
    >
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

function FactFacetLive({ stats }: { readonly stats: ReturnType<typeof useFactFacetStats> }) {
  return (
    <section data-testid="fact-facet-live" className="mt-4 max-w-3xl border-t border-border pt-4">
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

/**
 * 声明的可配置项(governed-entity-design §2 的九项,不多不少)。本波次是**只读呈现**:
 * 写路在 vertical 声明文件上,GUI 不做第二条编辑入口。
 */
function DeclarationFacets({ declaration }: { readonly declaration: EntityKindDeclaration }) {
  const rows: readonly (readonly [string, string])[] = [
    ["id", declaration.id],
    ["version", String(declaration.version)],
    ["idPrefix", declaration.idPrefix],
    ["display.singular", declaration.display.singular],
    ["display.plural", declaration.display.plural],
    ["descriptorSchemaRef", declaration.descriptorSchemaRef],
    ["store.pathTemplate", declaration.pathTemplate],
    ["locatorKinds", declaration.locatorKinds.join(", ")],
    ["maturityVocabulary", declaration.maturityVocabulary.join(", ") || "(未声明)"],
  ];
  return (
    <section data-testid="entity-declaration-facets" className="mt-6 max-w-3xl border-t border-border pt-4">
      <h2 className="ui-body font-semibold">声明的可配置项</h2>
      <p className="mt-1 ui-micro leading-relaxed text-text-faint">
        这些值来自本仓 vertical 声明。id / version 一起构成身份——改它们是换一个类型,不是改一个字段; display
        只影响呈现。此面只读,改声明请改 vertical 定义文件。
      </p>
      <dl className="mt-2 grid grid-cols-[minmax(140px,auto)_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-mono ui-micro text-text-faint">{label}</dt>
            <dd className="break-all font-mono ui-meta text-text">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
