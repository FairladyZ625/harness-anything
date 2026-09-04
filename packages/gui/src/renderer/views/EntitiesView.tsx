import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "@phosphor-icons/react";
import { entityDocGroups, type EntityKindDoc } from "../entity-docs.ts";
import type { ViewId } from "../navigation/viewHistory.ts";
import { useEntityLiveCounts, type EntityLiveCount } from "../entities-data.ts";
import { EntityDocDetailView } from "./EntityDocDetailView.tsx";
import { entityKindQueryKeys, governedEntityRowsQuery, useEntityKindCatalog } from "../entity-kind-data.ts";
import { entityLocatorContentQuery } from "../entity-locator-client.ts";
import type { EntityKindCatalog } from "../entity-kind-catalog-client.ts";
import type { GovernedEntityRow } from "../graph/governedEntities.ts";

/**
 * 实体说明面(dec_2935057783CD5D56E9F287AE4D CH4):三元语与扩展实体集中在一
 * 个目录上「看见它们是什么」。双重身份:对内是限制面(受控词表与合法动作在这
 * 里可见,不允许随手自由文本),对外是产品展示面(陌生人第一次看懂三元语内核
 * 的入口)。目录 + 详情沿用 PresetsView 的范式(entitydoc/<kind> 深链接,推栈
 * 回撤原路返回);说明内容来自代码/schema 实况,漂移由契约测试拦下。
 */
export function EntitiesView({
  repoId,
  focusedRef,
  onOpenEntityDoc,
  onExitDetail,
  onOpenView,
  projectName,
}: {
  readonly repoId: string;
  /**
   * 详情落点。两种形态:`entitydoc/<kind>`(打开某 kind 的说明)与声明实体的
   * `<kind>/<entityId>`(打开该 kind 并选中这一个实体)。null = 目录页。
   */
  readonly focusedRef: string | null;
  readonly onOpenEntityDoc: (kind: string) => void;
  readonly onExitDetail: () => void;
  readonly onOpenView: (view: ViewId) => void;
  readonly projectName: string;
}) {
  const liveCounts = useEntityLiveCounts(repoId);
  // 分组来自已注册 kind 读面:声明一个新 kind,这一页不改代码就多一条目录项。
  const { catalog } = useEntityKindCatalog(repoId);
  useDeepLinkedEntityContent(repoId, focusedRef);
  const groups = entityDocGroups(catalog);
  const focus = resolveEntityDocFocus(focusedRef, catalog);
  if (focus)
    return (
      <EntityDocDetailView
        repoId={repoId}
        kind={focus.kind}
        selectedEntityRef={focus.entityRef}
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
          <span className="font-mono ui-micro text-text-faint">{repoId}</span>
        </div>
        <p className="mt-1 max-w-3xl ui-meta leading-relaxed text-text-faint">
          这套内核由三元语构成:task 做什么、decision 为什么、fact 看到了什么,relation 把它们连成语义网。
          每个实体是什么、字段什么含义、彼此什么关系,都在这里说清楚;受控词表与合法写入动作也在这里可见——
          这一页既是防止乱写的限制面,也是这个产品对外的自我介绍。
        </p>
      </header>
      <div data-testid="entities-content" className="w-full space-y-6 p-4">
        {groups.map((group) => (
          <section key={group.id} data-testid={`entity-doc-group-${group.id}`}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="ui-body font-semibold">{group.title}</h2>
              <span className="ui-micro text-text-faint">{group.summary}</span>
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

/**
 * 目录卡片。长 kind 名(声明实体的 `software/coding/x@1`)与它的路径模板都是
 * 不含空格的机器字面量,常规断行救不了:kind 名 `break-all` 兜底换行并把全名放进
 * `title`,路径模板独立成第二行——两者不再共享一行窄空间互相顶出去。
 */
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
      <div className="flex min-w-0 items-start gap-2">
        <b title={doc.kind} className="min-w-0 flex-1 self-center break-all font-mono ui-body leading-snug text-text">
          {doc.kind}
        </b>
        {live ? (
          <span title="本仓活行数" className="ml-auto shrink-0 self-center font-mono ui-micro text-text-muted">
            {liveLabel(live)}
          </span>
        ) : null}
      </div>
      {doc.refTemplate ? (
        <code
          title={doc.refTemplate}
          className="mt-0.5 block break-all font-mono ui-micro leading-snug text-text-faint"
        >
          {doc.refTemplate}
        </code>
      ) : null}
      <p className="mt-1 line-clamp-2 ui-meta leading-relaxed text-text-muted">{doc.definition}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {doc.schemaId && (
          <span className="rounded border border-border px-1 py-px font-mono ui-micro text-text-faint">
            {doc.schemaId}
          </span>
        )}
        <span className="rounded border border-border px-1 py-px font-mono ui-micro text-text-faint">
          {doc.fields.length} 字段
        </span>
        {doc.edges.length > 0 && (
          <span className="rounded border border-border px-1 py-px font-mono ui-micro text-text-faint">
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

/**
 * 落点数据的预取:让深链接的正文不被渲染门控。
 *
 * 不预取时这条读链是三段串行,而且每段都要等上一段**渲染完**才开始:kind 目录回
 * 来详情才挂载,详情挂载了行读才发出,行读回来才知道选中谁、才挂渲染面,渲染面
 * 挂上了 locator 正文读才发出。query 通知订阅者走宏任务,于是深链接的正文比别的
 * 落点整整多等两轮——本地看不出来,CI 上就是间歇性的空白右栏。
 *
 * 依赖是数据依赖,不是渲染依赖:行读不依赖 kind 目录,locator 只依赖行读。所以在
 * 挂载当拍直接按数据依赖把两段拉进 query 缓存,渲染面照常消费同一份声明(命中缓
 * 存,不重复读)。落点不是声明实体时没有行能匹配上 ref,链在第一段自然停住。
 */
function useDeepLinkedEntityContent(repoId: string, focusedRef: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (focusedRef === null) return;
    void (async () => {
      await queryClient.prefetchQuery(governedEntityRowsQuery(repoId));
      const rows = queryClient.getQueryData<readonly GovernedEntityRow[]>(entityKindQueryKeys.rows(repoId));
      const locator = rows?.find((entity) => entity.ref === focusedRef)?.locator ?? null;
      if (locator === null) return;
      const content = entityLocatorContentQuery(repoId, locator);
      if (!content.enabled) return;
      await queryClient.prefetchQuery(content);
    })();
  }, [focusedRef, queryClient, repoId]);
}

/**
 * 详情落点解析。`entitydoc/<kind>` 是「看这个 kind 的说明」;声明实体的整条 ref
 * 是「看这个 kind 的说明,并选中这一个实体」。kind 可以带斜杠,所以按读面上的
 * kind 清单做最长前缀匹配,不按段数猜。
 */
export function resolveEntityDocFocus(
  ref: string | null,
  catalog: EntityKindCatalog,
): { readonly kind: string; readonly entityRef: string | null } | null {
  if (!ref) return null;
  if (ref.startsWith("entitydoc/")) {
    const kind = ref.slice("entitydoc/".length);
    return kind ? { kind, entityRef: null } : null;
  }
  const kind = catalog.kinds
    .map(({ kind: candidate }) => candidate)
    .filter((candidate) => ref.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  return kind === undefined ? null : { kind, entityRef: ref };
}
