import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ArrowLeft,
  CaretRight,
  FileText,
  CheckCircle,
  XCircle,
  Question,
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
import { parseTaskContractDocuments, taskDocumentQuery, useTaskDocumentQuery } from "../task-data";
import { OUT_LABEL, IN_LABEL } from "../components/taskDetail/constants";
import { AxisRow, DocPresence } from "../components/taskDetail/widgets";
import { PhaseSteps } from "../components/taskDetail/PhaseSteps";
import { RelationRow } from "../components/taskDetail/RelationRow";
import { normalizeTaskId, spawningDecisionOf } from "../model/triadic";
import { TaskControlPanel } from "../components/TaskControlPanel.tsx";
import type { GuiSubmissionV1 } from "../../api/renderer-dto.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";

function DocBody({
  repoId,
  taskId,
  path,
}: {
  repoId: string;
  taskId: string;
  path: string | null;
}) {
  const document = useTaskDocumentQuery(repoId, taskId, path);
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
  return <><span data-testid="task-document-status" className="mb-3 block font-mono text-[11px] text-text-faint">L2 · {document.data.status}</span>{document.data.status !== "ready" ? <p className="text-[13px] text-text-muted">canonical document projection 尚未追平</p> : document.data.blobSha256 === null ? <p className="text-[13px] text-stale">canonical document 未投影</p> : <DocReader content={document.data.body} />}</>;
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
  mutationFeedback,
  onProgress,
  onSubmit,
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
  mutationFeedback?: TaskMutationFeedback;
  onProgress?: (input: { text: string; evidence: ReadonlyArray<{ type: string; path: string; summary: string }> }) => Promise<unknown>;
  onSubmit?: (submission: GuiSubmissionV1) => Promise<unknown>;
}) {
  const external = isExternal(task);
  const canonicalPackage = typeof task.packagePath === "string", contract = useTaskDocumentQuery(task.projectId, task.taskId, canonicalPackage ? "task-contract.json" : null);
  const contractModel = useMemo(() => {
    if (!canonicalPackage) return { docs: task.packagePath === undefined ? task.docs : [], issue: null as string | null };
    if (contract.isError) return { docs: [], issue: contract.error.message };
    if (!contract.data || contract.data.status !== "ready") return { docs: [], issue: null };
    try { return { docs: parseTaskContractDocuments(task.taskId, contract.data.body), issue: null }; }
    catch (error) { return { docs: [], issue: error instanceof Error ? error.message : String(error) }; }
  }, [canonicalPackage, contract.data, contract.error, contract.isError, task.docs, task.packagePath, task.taskId]);
  const documentReads = useQueries({ queries: contractModel.docs.map((entry) => ({ ...taskDocumentQuery(task.projectId, task.taskId, entry.path) })) });
  const realDocs = useMemo(() => contractModel.docs.map((entry, index) => { const read = documentReads[index];
    if (!read || read.isPending || read.isError || !read.data || read.data.status !== "ready") return { ...entry, present: false, presence: "unknown" as const };
    return { ...entry, present: read.data.blobSha256 !== null, presence: read.data.blobSha256 !== null ? "present" as const : "missing" as const };
  }), [contractModel.docs, documentReads]);
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
            <CaretRight weight="bold" className="shrink-0 text-[11px]" />
            <button onClick={onBack} className="truncate hover:text-text-muted">
              {fromViewLabel}
            </button>
            <CaretRight weight="bold" className="shrink-0 text-[11px]" />
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
              {contractModel.issue ? `task-contract 读取失败：${contractModel.issue}` : canonicalPackage && contract.isPending ? "读取 canonical task-contract…" : "投影未返回文档清单"}
            </div>
          ) : (
            docGroups.map((g) => {
              const groupDocs = realDocs.filter((d) => d.group === g);
              const presentCount = groupDocs.filter((d) => d.present).length;
              return (
                <div key={g} className="mb-3">
                  <div className="flex items-center justify-between px-1 pb-1">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                      {g}
                    </span>
                    <span className="font-mono text-[11px] text-text-faint">
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
                        <span className="shrink-0 rounded border border-border px-1 text-[11px] leading-[1.5] text-text-faint">
                          必需
                        </span>
                      )}
                      {d.presence === "missing" && d.required && (
                        <span
                          className="shrink-0 text-[11px]"
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
                className="self-center text-[11px] text-text-faint"
              />
              <span className="text-[12px] text-text-muted">{doc?.group ?? "—"}</span>
              <CaretRight
                weight="bold"
                className="self-center text-[11px] text-text-faint"
              />
              <span className="text-[13px] font-semibold text-text">{doc?.title ?? "无文档"}</span>
              {doc && (
                <span className="ml-2 font-mono text-[11px] text-text-faint">
                  {doc.path}
                </span>
              )}
            </div>
            <DocBody
              repoId={task.projectId}
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
                canonical: {task.canonicalStatus ?? "unknown"} · 原文: {task.rawStatus}
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

            <AxisRow label="placement">
              <span className="w-full font-mono text-[11px] text-text-muted">modules: {task.moduleKeys?.join(", ") || "未投影"}</span>
              <span className="w-full font-mono text-[11px] text-text-muted">productLines: {task.productLines?.join(", ") || "未投影"}</span>
              <span className="w-full font-mono text-[11px] text-text-muted">parent/root: {task.parentTaskId ?? "root"} / {task.rootTaskId ?? task.taskId}</span>
              <span className="w-full font-mono text-[11px] text-text-muted">origin/engine: {task.origin ?? "unknown"} / {task.engine}</span>
              {task.placementWarning && <span className="w-full text-[11px] text-stale">{task.placementWarning}</span>}
              {task.placementProvenance?.map((entry) => <span key={`${entry.kind}:${entry.ref}`} className="w-full truncate font-mono text-[11px] text-text-faint">{entry.kind}: {entry.ref}</span>)}
            </AxisRow>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                阶段
              </span>
              <PhaseSteps status={task.canonicalStatus ?? "unknown"} />
            </div>

            <TaskControlPanel task={task} feedback={mutationFeedback} onProgress={onProgress} onSubmit={onSubmit} />

            {spawningDecision && (
              <div className="flex flex-col gap-1.5 rounded-md border border-accent/20 bg-accent/5 px-2.5 py-2">
                <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
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
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                Gates
              </span>
              {task.gates.length === 0 ? (
                <span className="text-[11px] text-text-faint">无 gate 记录</span>
              ) : (
                task.gates.map((g) => (
                  <div key={g.name} className="flex items-center gap-1.5 text-[11px]">
                    {g.ok === true ? (
                      <CheckCircle
                        weight="bold"
                        className="shrink-0 text-[12px]"
                        style={{ color: "var(--color-status-done)" }}
                      />
                    ) : g.ok === false ? (
                      <XCircle
                        weight="bold"
                        className="shrink-0 text-[12px]"
                        style={{ color: "var(--color-danger)" }}
                      />
                    ) : <Question weight="bold" className="shrink-0 text-[12px] text-stale" />}
                    <span className="shrink-0 font-mono text-text-muted">{g.name}</span>
                    {g.detail && (
                      <span className={`min-w-0 truncate ${g.ok === null ? "text-stale" : "text-danger"}`}>{g.detail}</span>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                关系
              </span>
              <span className="text-[11px] text-text-faint">只读 · 请在 canonical relation 来源处理</span>
              {outEdges.length === 0 && inEdges.length === 0 ? (
                <span className="text-[11px] text-text-faint">无关联任务</span>
              ) : (
                <>
                  {outEdges.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-text-faint">出边</span>
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
                      <span className="text-[11px] text-text-faint">入边</span>
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
