import { useEffect, useState } from "react";
import { ArrowLeft, ArrowSquareOut, CaretRight } from "@phosphor-icons/react";
import { entityDocIndex, type EntityFieldDoc, type EntityKindDoc } from "../entity-docs.ts";
import { useEntityKindCatalog, useGovernedEntityRows } from "../entity-kind-data.ts";
import { findEntityKind, type EntityKindDeclaration, type EntityKindRow } from "../entity-kind-catalog-client.ts";
import { GovernedEntityPanel } from "../components/entityDoc/GovernedEntityPanel.tsx";
import { EntityLocatorPreview } from "../components/entityDoc/EntityLocatorPreview.tsx";
import { FactFacetLive, FactTypeVocabulary } from "../components/entityDoc/FactVocabularySections.tsx";
import type { ViewId } from "../navigation/viewHistory.ts";
import { useFactFacetStats, type EntityLiveCounts } from "../entities-data.ts";
import type { GovernedEntityRow } from "../graph/governedEntities.ts";

/** 左列宽度:说明内容(字段表/词表/实体清单)的可读下限,右栏渲染器吃掉全部剩余。 */
const LEFT_COLUMN_CLASS = "w-[400px] shrink-0 overflow-y-auto border-r border-border px-4 py-4";

/**
 * 实体页·详情:两栏骨架——左列(固定宽,内部自滚动)承载说明本体:描述、存放、
 * GUI 入口、核心字段(含合法写入动作)、状态词表、关系,以及声明实体的「本仓实体」
 * 清单(含搜索与新建);右栏是选中实体的自适应渲染器(`entity-locator-renderer.ts`
 * 按 locator 类型选),占满剩余宽度与全高,未选中时呈真实空态。内核实体(task /
 * decision / …)沿用同一骨架,右栏保持空态——不做两套布局。
 *
 * Fact 详情额外承载 Type 受控词表配置区(dec_2935057783CD5D56E9F287AE4D)。
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
  // 选中实体由右栏渲染,选择状态上提到这里:左列清单只报 onSelect。
  const [selectedRef, setSelectedRef] = useState<string | null>(selectedEntityRef);
  useEffect(() => {
    setSelectedRef(selectedEntityRef);
  }, [selectedEntityRef]);
  const allGovernedRows = useGovernedEntityRows(repoId);
  const governedRows =
    catalogRow !== null && catalogRow.origin === "vertical"
      ? allGovernedRows.filter((entity) => entity.kind === kind)
      : [];
  const selectedEntity = governedRows.find((entity) => entity.ref === selectedRef) ?? null;
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid={`entity-doc-detail-${doc.kind}`}>
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
              <h1
                title={doc.kind}
                className="truncate font-mono ui-title font-semibold leading-5 tracking-[-0.01em] text-text"
              >
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

      <div className="flex min-h-0 flex-1">
        <aside className={LEFT_COLUMN_CLASS} data-testid="entity-doc-detail-left">
          <section>
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
                <h4 className="mb-1.5 font-mono ui-micro uppercase tracking-wide text-text-faint">
                  {nested.container}
                </h4>
                <FieldTable fields={nested.fields} />
              </div>
            ))}
          </DetailSection>

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
                加粗端是本实体。方向注册表规定哪种 (源, 动词, 目标) 三元组合法;未注册的组合写不进台账。
              </p>
            </DetailSection>
          )}

          {doc.kind === "fact" && <FactTypeVocabulary stats={factStats} />}
          {doc.kind === "fact" && <FactFacetLive stats={factStats} />}
          {catalogRow !== null && catalogRow.origin === "vertical" && (
            <DeclarationFacets declaration={catalogRow.declaration} />
          )}
          {catalogRow !== null && catalogRow.origin === "vertical" && (
            <GovernedEntityPanel
              repoId={repoId}
              row={catalogRow}
              rows={governedRows}
              selectedRef={selectedRef}
              onSelect={setSelectedRef}
            />
          )}
        </aside>

        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-testid="entity-doc-detail-right"
          aria-label="实体正文"
        >
          <DetailRendererPane
            repoId={repoId}
            doc={doc}
            catalogRow={catalogRow}
            governedRowCount={governedRows.length}
            selectedEntity={selectedEntity}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * 右栏:声明实体选中后按 locator 渲染正文;未选中呈真实空态。内核实体的正文不在
 * 账本里,右栏保持空态并指向它的实况入口,不编造内容。
 */
function DetailRendererPane({
  repoId,
  doc,
  catalogRow,
  governedRowCount,
  selectedEntity,
}: {
  readonly repoId: string;
  readonly doc: EntityKindDoc;
  readonly catalogRow: EntityKindRow | null;
  readonly governedRowCount: number;
  readonly selectedEntity: GovernedEntityRow | null;
}) {
  const declared = catalogRow !== null && catalogRow.origin === "vertical";
  if (!declared)
    return (
      <RendererEmptyState
        message={
          doc.guiEntry
            ? "这个 kind 的实况在专属页面;从右上「看实况」进入,说明看左列。"
            : "这个 kind 没有仓内正文;这一页只做说明。"
        }
      />
    );
  if (selectedEntity === null)
    return (
      <RendererEmptyState
        message={
          governedRowCount === 0
            ? "本仓还没有这个 kind 的实体;在左列新建后,正文在这里渲染。"
            : "从左侧选择一个实体,正文在这里渲染。"
        }
      />
    );
  if (selectedEntity.locator === null)
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="entity-locator-none">
        <p className="max-w-sm text-center ui-meta leading-relaxed text-text-faint">
          {selectedEntity.title ?? selectedEntity.entityId} 没有 locator,没有可渲染的正文。
        </p>
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="entity-doc-renderer">
      <EntityLocatorPreview repoId={repoId} locator={selectedEntity.locator} />
    </div>
  );
}

function RendererEmptyState({ message }: { readonly message: string }) {
  return (
    <div
      data-testid="entity-doc-renderer-empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-center p-6"
    >
      <p className="max-w-sm text-center ui-meta leading-relaxed text-text-faint">{message}</p>
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
    <section data-testid={testId} className="mt-6 border-t border-border pt-4">
      <h3 className="mb-2 ui-meta font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 字段清单:左列只有 400px,四列表格会被挤成竖排文字墙。改为每字段一小块——
 * 名字(可断行)+ 必填/可选 + 形状一行,人话含义换行跟在下面。
 */
function FieldTable({ fields }: { readonly fields: readonly EntityFieldDoc[] }) {
  return (
    <ul className="border-t border-border/60">
      {fields.map((field) => (
        <li key={field.name} className="flex flex-col gap-0.5 border-b border-border/60 py-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <code className="break-all font-mono ui-micro text-text">{field.name}</code>
            {field.required ? (
              <span className="font-mono ui-micro text-accent">必填</span>
            ) : (
              <span className="font-mono ui-micro text-text-faint">可选</span>
            )}
            <span className="font-mono ui-micro text-text-faint">{field.shape}</span>
          </div>
          <p className="leading-relaxed text-text-muted ui-meta">{field.meaning}</p>
        </li>
      ))}
    </ul>
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
 * 声明的可配置项(governed-entity-design §2 的九项,不多不少)。本波次是**只读呈现**:
 * 写路在 vertical 声明文件上,GUI 不做第二条编辑入口。
 */
function DeclarationFacets({ declaration }: { readonly declaration: EntityKindDeclaration | null }) {
  if (declaration === null) return null;
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
    <section data-testid="entity-declaration-facets" className="mt-6 border-t border-border pt-4">
      <h2 className="ui-body font-semibold">声明的可配置项</h2>
      <p className="mt-1 ui-micro leading-relaxed text-text-faint">
        这些值来自本仓 vertical 声明。id / version 一起构成身份——改它们是换一个类型,不是改一个字段; display
        只影响呈现。此面只读,改声明请改 vertical 定义文件。
      </p>
      <dl className="mt-2 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-1">
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
