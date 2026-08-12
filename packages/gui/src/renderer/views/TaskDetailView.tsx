import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CaretRight,
  FileText,
  CheckCircle,
  XCircle,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  TaskRow,
  RelationEdge,
} from "../model/types";
import { isExternal, DOC_GROUPS } from "../model/types";
import {
  StatusBadge,
  CloseoutBadge,
  DecisionSourceBadge,
  EngineBadge,
  FreshnessTag,
} from "../components/badges";
import { DocReader } from "../components/DocReader";
import { useTaskDocumentQuery } from "../task-data";
import { OUT_LABEL, IN_LABEL } from "../components/taskDetail/constants";
import { AxisRow, DocPresence } from "../components/taskDetail/widgets";
import { PhaseSteps } from "../components/taskDetail/PhaseSteps";
import { RelationRow } from "../components/taskDetail/RelationRow";
import { normalizeTaskId, spawningDecisionOf } from "../model/triadic";

function DocBody({
  taskId,
  path,
}: {
  taskId: string;
  path: string | null;
}) {
  const document = useTaskDocumentQuery(taskId, path);
  if (!path) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong py-16 text-center">
        <FileText weight="duotone" className="text-2xl text-text-faint" />
        <p className="text-[13px] text-text-muted">该任务无投影文档</p>
        <p className="font-mono text-[11px] text-text-faint">从 preset 物化的 doc 清单为空</p>
      </div>
    );
  }
  if (document.isPending) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong py-16 text-center">
        <FileText weight="duotone" className="text-2xl text-text-faint" />
        <p className="text-[13px] text-text-muted">读取 canonical document projection…</p>
      </div>
    );
  }
  if (document.isError) return <p className="text-[13px] text-status-blocked">文档投影读取失败：{document.error.message}</p>;
  return <><span data-testid="task-document-status" className="mb-3 block font-mono text-[11px] text-text-faint">L2 · {document.data.status}</span>{document.data.status === "ready" ? <DocReader content={document.data.body} /> : <p className="text-[13px] text-text-muted">canonical document projection 尚未追平</p>}</>;
}

export function TaskDetailView({
  task,
  onBack,
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
  const realDocs = task.docs.length ? task.docs : [{ path: "INDEX.md", title: "INDEX", group: "必读" as const, required: true, present: true }];
  // 文档清单只看必读/计划/设计/进度/收口/证据 6 组;其他归入进度(滚动日志)。
  const docGroups = useMemo(
    () => DOC_GROUPS.filter((g) => realDocs.some((d) => d.group === g)),
    [realDocs],
  );

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
        {/* 文档目录树 */}
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface p-3">
          {docGroups.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-2 py-3 text-[12px] text-text-faint">
              投影未返回文档清单
            </div>
          ) : (
            docGroups.map((g) => {
              const groupDocs = realDocs.filter((d) => d.group === g);
              const presentCount = groupDocs.filter((d) => d.present).length;
              return (
                <div key={g} className="mb-3">
                  <div className="flex items-center justify-between px-1 pb-1">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                      {g}
                    </span>
                    <span className="font-mono text-[10px] text-text-faint">
                      {presentCount}/{groupDocs.length}
                    </span>
                  </div>
                  {groupDocs.map((d) => (
                    <button
                      key={d.path}
                      onClick={() => setActiveDoc(d.path)}
                      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] ${
                        activeDoc === d.path
                          ? "bg-surface-raised text-text"
                          : "text-text-muted hover:text-text"
                      }`}
                    >
                      <DocPresence doc={d} />
                      <span className="min-w-0 truncate">{d.title}</span>
                      {d.required && (
                        <span className="shrink-0 rounded border border-border px-1 text-[9px] text-text-faint">
                          必需
                        </span>
                      )}
                      {!d.present && d.required && (
                        <span
                          className="shrink-0 text-[10px]"
                          style={{ color: "var(--color-danger)" }}
                        >
                          缺失
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              );
            })
          )}
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

          </div>
        </aside>
      </div>
    </div>
  );
}
