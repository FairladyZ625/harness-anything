import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CaretRight,
  FileText,
  Lock,
  CheckCircle,
  XCircle,
  ArrowSquareOut,
  Spinner,
  SealCheck,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  DocEntry,
  DocGroup,
  TaskRow,
  RelationEdge,
} from "../model/types";
import { isExternal, isTerminal } from "../model/types";
import {
  STATUS_META,
  StatusBadge,
  CloseoutBadge,
  DecisionSourceBadge,
  EngineBadge,
  FreshnessTag,
} from "../components/badges";
import { SAMPLE_MARKDOWN, DOC_CONTENT } from "../model/mock";
import { DocReader } from "../components/DocReader";
import {
  LOCAL_TRANSITIONS,
  OUT_LABEL,
  IN_LABEL,
} from "../components/taskDetail/constants";
import { AxisRow } from "../components/taskDetail/widgets";
import { PhaseSteps } from "../components/taskDetail/PhaseSteps";
import { RelationRow } from "../components/taskDetail/RelationRow";
import { DocTree } from "../components/taskDetail/DocTree";
import { buildDocTree } from "../model/docTree";
import { normalizeTaskId, spawningDecisionOf } from "../model/triadic";
import { useTaskDetailQuery, useTaskDocumentQuery, useReviewTaskMutation } from "../task-data";

/**
 * 推断文档分组:preset 模板里常见文件名 → DocGroup。投影只给 path,组别靠命名启发式。
 * 未命中归到「进度」(默认进度日志)。
 */
function inferDocGroup(path: string): DocGroup {
  const lower = path.toLowerCase();
  if (lower.includes("contract") || lower === "index.md") return "必读";
  if (lower.includes("plan") || lower.includes("roadmap") || lower.includes("task-plan")) return "计划";
  if (lower.includes("design") || lower.includes("adr") || lower.includes("architecture")) return "设计";
  if (lower.includes("progress")) return "进度";
  if (lower.includes("closeout") || lower.includes("verification") || lower.includes("verify")) return "收口";
  if (lower.includes("evidence") || lower.includes("fact") || lower.includes("lesson")) return "证据";
  return "进度";
}

function docTitleFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.md$/i, "");
  return stem
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * 文档阅读区:优先用真实 useTaskDocumentQuery 的 body;查询失败或加载中给出占位。
 * 当 activeDoc 为空(无文档可读)时回退到 SAMPLE_MARKDOWN 占位以保留原型可用性。
 */
function DocBody({
  taskId,
  path,
  fallbackPresent,
}: {
  taskId: string;
  path: string | null;
  fallbackPresent: boolean;
}) {
  const documentQuery = useTaskDocumentQuery(path ? taskId : null, path);

  if (!path) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong py-16 text-center">
        <FileText weight="duotone" className="text-2xl text-text-faint" />
        <p className="text-[13px] text-text-muted">该任务无投影文档</p>
        <p className="font-mono text-[11px] text-text-faint">从 preset 物化的 doc 清单为空</p>
      </div>
    );
  }

  if (documentQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-8 text-[13px] text-text-muted">
        <Spinner weight="bold" className="animate-spin" />
        正在读取 {path} …
      </div>
    );
  }

  if (documentQuery.isError) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong py-12 text-center">
        <XCircle weight="duotone" className="text-2xl text-danger" />
        <p className="text-[13px] text-text">文档读取失败</p>
        <p className="font-mono text-[11px] text-text-faint">
          {(documentQuery.error as Error | undefined)?.message ?? "本地台账桥未返回正文"}
        </p>
        {fallbackPresent && (
          <p className="mt-2 font-mono text-[11px] text-text-faint">回退显示样例正文</p>
        )}
        {fallbackPresent && <DocReader content={DOC_CONTENT[path] ?? SAMPLE_MARKDOWN} />}
      </div>
    );
  }

  const body = documentQuery.data?.body ?? "";
  if (body.trim()) {
    return <DocReader content={body} />;
  }

  // body 空:既无 mock 命中也无真实正文
  if (!fallbackPresent) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong py-16 text-center">
        <FileText weight="duotone" className="text-2xl text-text-faint" />
        <p className="text-[13px] text-text-muted">文档未物化</p>
        <p className="font-mono text-[11px] text-text-faint">该骨架由 preset 定义</p>
      </div>
    );
  }
  return <DocReader content={DOC_CONTENT[path] ?? SAMPLE_MARKDOWN} />;
}

export function TaskDetailView({
  task,
  onBack,
  onUpdate,
  tasks,
  relations,
  decisions = [],
  onSelect,
  projectName,
  fromViewLabel = "工作区",
  onNavigateDecision,
  onNavigateEntity,
}: {
  task: TaskRow;
  onBack: () => void;
  onUpdate: (id: string, patch: Partial<TaskRow>) => void;
  tasks?: TaskRow[];
  relations?: RelationEdge[];
  decisions?: DecisionRow[];
  onSelect?: (id: string) => void;
  projectName: string;
  fromViewLabel?: string;
  /** W2B 活链接:DecisionSourceBadge 点击跳转 */
  onNavigateDecision?: (decisionId: string) => void;
  /** W2B 活链接:RelationRow 跨实体(decision/fact peer)跳转 */
  onNavigateEntity?: (ref: string) => void;
}) {
  const external = isExternal(task);
  // 真实文档清单:从 useTaskDetailQuery 拉,投影本身不内嵌 docs(task-adapter 给空数组)。
  const detailQuery = useTaskDetailQuery(task.taskId);
  // 收口机判:review gate 只机判 PASS/FAIL,人工不可覆写(dec_mrca9hx4 CH1)。
  const reviewMutation = useReviewTaskMutation();
  const realDocs = useMemo<DocEntry[]>(() => {
    const docs = detailQuery.data?.documents ?? [];
    if (docs.length === 0) return task.docs;
    return docs.map((d) => {
      const group = inferDocGroup(d.path);
      return {
        path: d.path,
        title: docTitleFromPath(d.path),
        group,
        required: group === "必读" || group === "收口",
        present: true,
      };
    });
  }, [detailQuery.data, task.docs]);
  // 文档路径分段树:按真实目录结构(artifacts/ 及更深子目录可展开),
  // 替代原来的 6-组扁平分组(inferDocGroup 把没匹配上的路径全倒进兜底桶)。
  const docTree = useMemo(() => buildDocTree(realDocs), [realDocs]);

  const [activeDoc, setActiveDoc] = useState(
    () => realDocs[0]?.path ?? task.docs[0]?.path ?? "",
  );
  useEffect(() => {
    // 任务切换或文档清单刷新时,如果当前 activeDoc 失效,重置到首篇。
    if (realDocs.length === 0) {
      if (activeDoc !== "") setActiveDoc("");
      return;
    }
    if (!realDocs.some((d) => d.path === activeDoc)) {
      setActiveDoc(realDocs[0].path);
    }
  }, [realDocs, activeDoc]);

  const doc = realDocs.find((d) => d.path === activeDoc) ?? realDocs[0];

  const rels = relations ?? [];
  const outEdges = rels.filter((r) => normalizeTaskId(r.from) === task.taskId);
  const inEdges = rels.filter((r) => normalizeTaskId(r.to) === task.taskId);
  const peerTitle = (id: string) =>
    tasks?.find((t) => t.taskId === normalizeTaskId(id))?.title ?? "";
  const spawningDecision = spawningDecisionOf(task, rels);
  const spawningDecisionTitle = decisions.find((d) => d.decisionId === spawningDecision)?.title;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface/70 px-4 py-3">
        <button
          onClick={onBack}
          className="rounded-md border border-border p-1.5 text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text"
          title="返回上一层"
        >
          <ArrowLeft weight="bold" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-text-faint">
            <button onClick={onBack} className="truncate hover:text-text-muted">
              {projectName}
            </button>
            <CaretRight weight="bold" className="shrink-0 text-[10px]" />
            <button onClick={onBack} className="truncate hover:text-text-muted">
              {fromViewLabel}
            </button>
            <CaretRight weight="bold" className="shrink-0 text-[10px]" />
            <span className="shrink-0 text-text-muted">{task.taskId}</span>
          </div>
          <h1 className="ui-title truncate font-semibold leading-6 text-text">
            {task.title}
          </h1>
        </div>
        <div className="ml-auto">
          <EngineBadge engine={task.engine} locked={external} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 文档目录树(路径分段树,支持展开 artifacts/ 及更深子目录) */}
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface p-3">
          <DocTree
            nodes={docTree}
            activeDoc={activeDoc}
            onSelectDoc={setActiveDoc}
          />
        </nav>

        {/* 文档阅读区 */}
        <article className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-[72ch]">
            <div className="mb-4 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border-b border-border pb-3">
              <span className="font-mono text-[11px] text-text-faint">
                {task.taskId}
              </span>
              <CaretRight
                weight="bold"
                className="self-center text-[9px] text-text-faint"
              />
              <span className="text-[12px] text-text-muted">{doc?.group ?? "—"}</span>
              <CaretRight
                weight="bold"
                className="self-center text-[9px] text-text-faint"
              />
              <span className="text-[13px] font-semibold text-text">{doc?.title ?? "无文档"}</span>
              {doc && (
                <span className="ml-2 font-mono text-[10px] text-text-faint">
                  {doc.path}
                </span>
              )}
            </div>
            <DocBody
              taskId={task.taskId}
              path={doc?.path ?? null}
              fallbackPresent={Boolean(doc?.present)}
            />
          </div>
        </article>

        {/* 治理侧栏：三轴并排 */}
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-border bg-surface p-4">
          <div className="flex flex-col gap-4">
            <AxisRow label="coordinationStatus">
              <StatusBadge status={task.coordinationStatus} />
              <span className="w-full font-mono text-[11px] text-text-faint">
                原文: {task.rawStatus}
              </span>
              <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
            </AxisRow>

            <AxisRow label="closeoutReadiness">
              <CloseoutBadge value={task.closeoutReadiness} />
            </AxisRow>

            <AxisRow label="packageDisposition">
              <span className="font-mono text-[12px] text-text-muted">
                {task.packageDisposition}
              </span>
            </AxisRow>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                阶段
              </span>
              <PhaseSteps status={task.coordinationStatus} />
            </div>

            {spawningDecision && (
              <div className="flex flex-col gap-1.5 rounded-md border border-accent/20 bg-accent/5 px-2.5 py-2">
                <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                  Decision 上游
                </span>
                <DecisionSourceBadge
                  decisionId={spawningDecision}
                  title={spawningDecisionTitle}
                  onNavigate={onNavigateDecision ? () => onNavigateDecision(spawningDecision) : undefined}
                />
                {spawningDecisionTitle && (
                  <span className="text-[11px] leading-snug text-text-muted">
                    {spawningDecisionTitle}
                  </span>
                )}
              </div>
            )}

            <hr className="border-border" />

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                Gates
              </span>
              {task.gates.length === 0 ? (
                <span className="text-[11px] text-text-faint">无 gate 记录</span>
              ) : (
                task.gates.map((g) => (
                  <div key={g.name} className="flex items-center gap-1.5 text-[11px]">
                    {g.ok ? (
                      <CheckCircle
                        weight="bold"
                        className="shrink-0 text-[12px]"
                        style={{ color: "var(--color-status-done)" }}
                      />
                    ) : (
                      <XCircle
                        weight="bold"
                        className="shrink-0 text-[12px]"
                        style={{ color: "var(--color-danger)" }}
                      />
                    )}
                    <span className="shrink-0 font-mono text-text-muted">{g.name}</span>
                    {g.detail && (
                      <span className="min-w-0 truncate text-danger">{g.detail}</span>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                关系
              </span>
              {outEdges.length === 0 && inEdges.length === 0 ? (
                <span className="text-[11px] text-text-faint">无关联任务</span>
              ) : (
                <>
                  {outEdges.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] text-text-faint">出边</span>
                      {outEdges.map((r, i) => (
                        <RelationRow
                          key={`out-${r.kind}-${r.to}-${i}`}
                          peer={r.to}
                          label={OUT_LABEL[r.kind]}
                          provenance={r.provenance}
                          title={peerTitle(r.to)}
                          onSelect={onSelect}
                          onNavigateEntity={onNavigateEntity}
                        />
                      ))}
                    </div>
                  )}
                  {inEdges.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] text-text-faint">入边</span>
                      {inEdges.map((r, i) => (
                        <RelationRow
                          key={`in-${r.kind}-${r.from}-${i}`}
                          peer={r.from}
                          label={IN_LABEL[r.kind]}
                          provenance={r.provenance}
                          title={peerTitle(r.from)}
                          onSelect={onSelect}
                          onNavigateEntity={onNavigateEntity}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <hr className="border-border" />

            {/* 操作区：external 灰显 + 引导 */}
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                状态转换
              </span>
              {external ? (
                <div className="rounded-md border border-border bg-surface-raised p-2.5">
                  <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
                    <Lock weight="bold" />
                    由 {task.engine} 管理
                  </div>
                  <button className="mt-2 inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
                    在 {task.engine} 中打开
                    <ArrowSquareOut weight="bold" />
                  </button>
                </div>
              ) : isTerminal(task.coordinationStatus) ? (
                <p className="text-[12px] text-text-faint">终态不可再转出</p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {LOCAL_TRANSITIONS.filter(
                    (s) => s !== task.coordinationStatus,
                  ).map((s) => (
                    <button
                      key={s}
                      onClick={() =>
                        onUpdate(task.taskId, {
                          coordinationStatus: s,
                          rawStatus: s,
                        })
                      }
                      className="rounded-md border border-border px-2 py-1 text-left font-mono text-[11px] text-text-muted hover:border-border-strong hover:text-text active:scale-[0.98]"
                      style={{ color: STATUS_META[s].color }}
                    >
                      → {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {task.closeoutReadiness === "ready" && (
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                  收口机判
                </span>
                <button
                  onClick={() => reviewMutation.mutate({ taskId: task.taskId })}
                  disabled={reviewMutation.isPending}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[12px] font-semibold text-accent-fg active:scale-[0.98] disabled:opacity-50"
                >
                  <SealCheck weight="bold" />
                  {reviewMutation.isPending ? "机判中…" : "请求 review gate 机判"}
                </button>
                {reviewMutation.isError && (
                  <p className="text-[11px] leading-relaxed text-danger">
                    机判请求失败:{(reviewMutation.error as Error)?.message ?? "本地台账桥未返回"}
                  </p>
                )}
                <p className="text-[11px] leading-relaxed text-text-faint">
                  判定由 review gate 机判(PASS/FAIL 由 findings 与 gates 决定),人工不可覆写。结果经投影重读回写 closeoutReadiness。
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
