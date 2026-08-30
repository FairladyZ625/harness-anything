import { BookOpen } from "@phosphor-icons/react";
import { ENTITY_DOC_GROUPS, type EntityKindDoc } from "../entity-docs.ts";
import type { ViewId } from "../navigation/viewHistory.ts";
import { useEntityLiveCounts, type EntityLiveCount } from "../entities-data.ts";
import { EntityDocDetailView } from "./EntityDocDetailView.tsx";

/**
 * 实体说明面(dec_2935057783CD5D56E9F287AE4D CH4):三元语与扩展实体集中在一
 * 个目录上「看见它们是什么」。双重身份:对内是限制面(受控词表与合法动作在这
 * 里可见,不允许随手自由文本),对外是产品展示面(陌生人第一次看懂三元语内核
 * 的入口)。目录 + 详情沿用 PresetsView 的范式(entitydoc/<kind> 深链接,推栈
 * 回撤原路返回);说明内容来自代码/schema 实况,漂移由契约测试拦下。
 */
export function EntitiesView({
  repoId,
  focusedEntityDocKind,
  onOpenEntityDoc,
  onExitDetail,
  onOpenView,
  projectName,
}: {
  readonly repoId: string;
  /** entitydoc/<kind> 深链接解析出的详情落点;null = 目录页。 */
  readonly focusedEntityDocKind: string | null;
  readonly onOpenEntityDoc: (kind: string) => void;
  readonly onExitDetail: () => void;
  readonly onOpenView: (view: ViewId) => void;
  readonly projectName: string;
}) {
  const liveCounts = useEntityLiveCounts(repoId);
  if (focusedEntityDocKind)
    return (
      <EntityDocDetailView
        repoId={repoId}
        kind={focusedEntityDocKind}
        liveCounts={liveCounts}
        projectName={projectName}
        fromViewLabel={NAV_SELF_LABEL}
        onBack={onExitDetail}
        onOpenView={onOpenView}
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3" data-testid="entities-header">
        <div className="flex flex-wrap items-center gap-2">
          <BookOpen className="text-text-faint" />
          <h1 className="ui-title font-semibold">实体说明</h1>
          <span className="font-mono text-[11px] text-text-faint">{repoId}</span>
        </div>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-text-faint">
          这套内核由三元语构成:task 做什么、decision 为什么、fact 看到了什么,relation 把它们连成语义网。
          每个实体是什么、字段什么含义、彼此什么关系,都在这里说清楚;受控词表与合法写入动作也在这里可见——
          这一页既是防止乱写的限制面,也是这个产品对外的自我介绍。
        </p>
      </header>
      <div data-testid="entities-content" className="w-full space-y-6 p-4">
        {ENTITY_DOC_GROUPS.map((group) => (
          <section key={group.id} data-testid={`entity-doc-group-${group.id}`}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold">{group.title}</h2>
              <span className="text-[11px] text-text-faint">{group.summary}</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-2">
              {group.docs.map((doc) => (
                <EntityDocCard
                  key={doc.kind}
                  doc={doc}
                  live={doc.liveCount === null ? null : liveCounts[doc.liveCount]}
                  onOpen={() => onOpenEntityDoc(doc.kind)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const NAV_SELF_LABEL = "实体说明";

function EntityDocCard({
  doc,
  live,
  onOpen,
}: {
  readonly doc: EntityKindDoc;
  readonly live: EntityLiveCount | null;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`entity-doc-card-${doc.kind}`}
      className={[
        "w-full rounded-lg border border-border bg-surface p-3 text-left transition-colors",
        "hover:border-border-strong",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <b className="font-mono text-[13px]">{doc.kind}</b>
        {doc.refTemplate && <code className="shrink-0 font-mono text-[10px] text-text-faint">{doc.refTemplate}</code>}
        {live ? (
          <span title="本仓活行数" className="ml-auto shrink-0 font-mono text-[10px] text-text-muted">
            {liveLabel(live)}
          </span>
        ) : null}
      </div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{doc.definition}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {doc.schemaId && (
          <span className="rounded border border-border px-1 py-px font-mono text-[10px] text-text-faint">
            {doc.schemaId}
          </span>
        )}
        <span className="rounded border border-border px-1 py-px font-mono text-[10px] text-text-faint">
          {doc.fields.length} 字段
        </span>
        {doc.edges.length > 0 && (
          <span className="rounded border border-border px-1 py-px font-mono text-[10px] text-text-faint">
            {doc.edges.length} 关系
          </span>
        )}
      </div>
    </button>
  );
}

function liveLabel(live: EntityLiveCount): string {
  if (live.state === "ready") return `${live.count}`;
  if (live.state === "error") return "读取失败";
  return "…";
}
