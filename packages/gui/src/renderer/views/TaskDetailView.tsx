import { useState } from "react";
import {
  ArrowLeft,
  CaretRight,
  FileText,
  Lock,
  CheckCircle,
  XCircle,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  TaskRow,
  RelationEdge,
} from "../model/types";
import { isExternal, isTerminal, DOC_GROUPS } from "../model/types";
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
import { AxisRow, DocPresence } from "../components/taskDetail/widgets";
import { PhaseSteps } from "../components/taskDetail/PhaseSteps";
import { RelationRow } from "../components/taskDetail/RelationRow";
import { normalizeTaskId, spawningDecisionOf } from "../model/triadic";

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
}) {
  const external = isExternal(task);
  const [activeDoc, setActiveDoc] = useState(task.docs[0]?.path ?? "");
  const doc = task.docs.find((d) => d.path === activeDoc) ?? task.docs[0];
  const docGroups = DOC_GROUPS.filter((g) => task.docs.some((d) => d.group === g));

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
          {docGroups.map((g) => {
            const groupDocs = task.docs.filter((d) => d.group === g);
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
          })}
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
              <span className="text-[12px] text-text-muted">{doc.group}</span>
              <CaretRight
                weight="bold"
                className="self-center text-[9px] text-text-faint"
              />
              <span className="text-[13px] font-semibold text-text">{doc.title}</span>
              <span className="ml-2 font-mono text-[10px] text-text-faint">
                {doc.path}
              </span>
            </div>
            {doc.present ? (
              <DocReader content={DOC_CONTENT[doc.path] ?? SAMPLE_MARKDOWN} />
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong py-16 text-center">
                <FileText weight="duotone" className="text-2xl text-text-faint" />
                <p className="text-[13px] text-text-muted">文档未物化</p>
                <p className="font-mono text-[11px] text-text-faint">
                  该骨架由 preset 定义
                </p>
              </div>
            )}
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
                <DecisionSourceBadge decisionId={spawningDecision} title={spawningDecisionTitle} />
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
                  Human Review
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() =>
                      onUpdate(task.taskId, { closeoutReadiness: "passed" })
                    }
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[12px] font-semibold text-accent-fg active:scale-[0.98]"
                  >
                    <CheckCircle weight="bold" />
                    Passed
                  </button>
                  <button
                    onClick={() =>
                      onUpdate(task.taskId, { closeoutReadiness: "failed" })
                    }
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] text-text-muted hover:text-danger active:scale-[0.98]"
                  >
                    <XCircle weight="bold" />
                    Failed
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-text-faint">
                  verdict 只写收口轴；打回重做需另行转换状态
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
