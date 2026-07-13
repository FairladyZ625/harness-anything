import { useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  WarningCircle,
  ClockClockwise,
  TreeStructure,
  PaperPlaneTilt,
  ProhibitInset,
  BugBeetle,
  Robot,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  DecisionClaim,
  TaskRow,
  RelationEdge,
  FactRef,
} from "../model/types";
import {
  DecisionStateBadge,
  RiskTierBadge,
  UrgencyBadge,
} from "../components/badges";
import {
  coverageOf,
  derivedTasks,
  factOf,
  rationaleFor,
  supersedeChain,
} from "../model/triadic";
import { CopyContextButton } from "../components/CopyContextButton";
import { buildEntityJumpContext } from "../model/copy-context";

const dateLabel = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

const formatActorAxes = (actor: DecisionRow["attribution"]["originator"], fallback: string) => actor
  ? `person:${actor.principal.personId} / ${actor.executor ? `agent:${actor.executor.id}` : "executor:none"}`
  : fallback;

// ============ 决策就绪信号灯(41 §3.1a)============

export type SignalColor = "green" | "yellow" | "red";

export interface ReadinessSignal {
  id: "evidence-liveness" | "applies-to-drift" | "coverage" | "conflict-marker";
  label: string;
  color: SignalColor;
  /** 判定摘要:命中时给"为什么黄/红",hover/展开时看 */
  summary: string;
}

/**
 * 计算四盏决策就绪信号灯(41 §3.1a 表)。
 * ⚠ mock 捷径:evidence 活性 + 覆盖度由 relation/fact 推导(真实为 TP-M3-06 图查询);
 * applies_to 漂移 + 冲突标记从 decision.readinessSignals 显式 mock 字段取(真实为
 * provenance.boundAt × git log / findConflictMarkers)。
 */
function computeReadinessSignals(
  d: DecisionRow,
  facts: FactRef[],
): ReadinessSignal[] {
  const signals: ReadinessSignal[] = [];

  // ① evidence 活性(黄):引用的 fact 被 invalidated-by/supersedes-fact 边指向(原型用 fact.invalidated)
  const deadEvidence: string[] = [];
  for (const c of [...d.chosen, ...d.rejected]) {
    for (const ref of c.evidence) {
      const anchor = ref.replace(/^fact\//, "");
      const f = facts.find((x) => x.anchor === anchor);
      if (f?.invalidated) deadEvidence.push(anchor);
    }
  }
  signals.push({
    id: "evidence-liveness",
    label: "evidence 活性",
    color: deadEvidence.length > 0 ? "yellow" : "green",
    summary:
      deadEvidence.length > 0
        ? `${deadEvidence.length} 条 evidence 引用了已失效 fact:${deadEvidence.join(", ")}(被 invalidated-by/supersedes-fact 边标记)`
        : "所有引用的 fact 均为活,未被失效边指向",
  });

  // ② applies_to 漂移(黄):propose 后 applies_to 文档有 commit(mock 显式字段)
  const drift = d.readinessSignals?.appliesToDrift;
  signals.push({
    id: "applies-to-drift",
    label: "applies_to 漂移",
    color: drift ? "yellow" : "green",
    summary: drift
      ? `propose 后 applies_to 文档被触碰:${drift.docs.join(", ")} · 最近 commit ${dateLabel(drift.lastCommitAt)}(基于 boundAt × git log)`
      : "propose 后 applies_to 文档无 commit 触碰",
  });

  // ③ 覆盖度(红):承重论点 → 活 fact 不可达
  const cov = coverageOf(d, facts);
  signals.push({
    id: "coverage",
    label: "覆盖度",
    color: cov.total > 0 && cov.covered < cov.total ? "red" : "green",
    summary:
      cov.total === 0
        ? "无承重论点"
        : cov.covered < cov.total
          ? `承重论点 ${cov.gaps.join(", ")} 无可达活 fact(${cov.covered}/${cov.total})`
          : `${cov.covered}/${cov.total} 论点有可达活 fact`,
  });

  // ④ 冲突标记(红):findConflictMarkers 命中(mock 显式字段)
  const conflict = d.readinessSignals?.conflictMarker;
  signals.push({
    id: "conflict-marker",
    label: "冲突标记",
    color: conflict ? "red" : "green",
    summary: conflict
      ? `findConflictMarkers 命中:${conflict.summary}(冲突实体 ${conflict.conflictingEntity},coordinator 写入时亦拒)`
      : "findConflictMarkers 未命中",
  });

  return signals;
}

/** 取四盏灯里最严重的色(红 > 黄 > 绿) */
function worstColor(signals: ReadinessSignal[]): SignalColor {
  if (signals.some((s) => s.color === "red")) return "red";
  if (signals.some((s) => s.color === "yellow")) return "yellow";
  return "green";
}

/** 单盏灯 */
function SignalLamp({ signal }: { signal: ReadinessSignal }) {
  const colorCls =
    signal.color === "red"
      ? "text-danger"
      : signal.color === "yellow"
        ? "text-stale"
        : "text-success";
  const dotCls =
    signal.color === "red"
      ? "bg-danger"
      : signal.color === "yellow"
        ? "bg-stale"
        : "bg-success";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] ${colorCls}`}
      title={signal.summary}
    >
      <span className={`size-1.5 rounded-full ${dotCls} ${signal.color !== "green" ? "animate-pulse" : ""}`} />
      {signal.label}
    </span>
  );
}

/** mock 的 coordinator 结构化拒因(冲突标记红灯 accept 时渲染,E52 R3) */
function buildConflictRejection(d: DecisionRow): { code: string; reason: string; detail: string[] } {
  const conflict = d.readinessSignals?.conflictMarker;
  return {
    code: "E_CONFLICT_MARKER",
    reason: `accept 被 coordinator 前置预检拒绝:findConflictMarkers 命中该 decision 包`,
    detail: conflict
      ? [
          `conflictingEntity: ${conflict.conflictingEntity}`,
          `summary: ${conflict.summary}`,
          `action: 先解决 ${conflict.conflictingEntity} 的并发修改冲突,重新 propose 或 amend`,
        ]
      : ["action: 解决并发冲突后重试"],
  };
}

/**
 * 两轴正交排序键(riskTier × urgency)。⚠ 不得合并为单一分数(TP-M3-01 两轴正交)。
 * 返回元组,lexicographic 比较即"先按 riskTier,同级再按 urgency"。
 * high=0 / medium=1 / low=2 —— 承重决策优先承重,承重同级里紧急优先。
 */
const axisRank = (v?: "high" | "medium" | "low") => (v === "high" ? 0 : v === "medium" ? 1 : v === "low" ? 2 : 3);
export const sortKey = (d: DecisionRow): readonly [number, number] =>
  [axisRank(d.riskTier), axisRank(d.urgency)] as const;

// ============ 单条决策卡(必显项五项,41 §3.1 表格)============

function FactChip({
  factRef,
  facts,
  relations,
  onInspect,
}: {
  factRef: string;
  facts: FactRef[];
  relations: RelationEdge[];
  onInspect: (factRef: string) => void;
}) {
  const f = factOf(factRef, facts);
  const rationale = rationaleFor(factRef, relations);
  if (!f) {
    // 悬空 fact(INV-6 悬空指针扫描检出)→ 标红警示
    return (
      <button
        onClick={() => onInspect(factRef)}
        className="inline-flex items-center gap-1 rounded border border-dashed border-danger/60 px-1.5 py-0.5 font-mono text-[11px] text-danger hover:bg-danger/10"
        title="悬空:引用不存在的 fact 锚"
      >
        <WarningCircle weight="bold" className="text-[11px]" />
        {factRef}
      </button>
    );
  }
  return (
    <button
      onClick={() => onInspect(factRef)}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${
        f.invalidated ? "text-stale line-through" : "text-success"
      } hover:bg-surface-raised`}
      title={`fact:${f.text}${f.invalidated ? " (已失效)" : ""}${rationale ? `\nrationale: ${rationale}` : ""}`}
    >
      <span className="font-sans text-text-faint">⟶</span>
      {f.anchor}
      {f.invalidated && <WarningCircle weight="bold" className="text-[10px]" />}
      {rationale && (
        <span className="font-sans normal-case text-text-faint not-italic">({rationale})</span>
      )}
    </button>
  );
}

function ClaimList({
  title,
  items,
  tone,
  facts,
  relations,
  onInspectFact,
}: {
  title: string;
  items: DecisionClaim[];
  tone: "chosen" | "rejected";
  facts: FactRef[];
  relations: RelationEdge[];
  onInspectFact: (factRef: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] font-semibold text-text-faint">
        {title}
        {tone === "rejected" && (
          <span className="ml-1 text-danger">· 否决比选择更重要,每条必带 why_not</span>
        )}
      </div>
      <ul className="mt-1 space-y-1.5">
        {items.map((c) => (
          <li key={c.id} className="text-[12px] leading-relaxed">
            <span className="font-mono text-text-faint">{c.id} </span>
            <span className={tone === "rejected" ? "text-text-muted line-through opacity-80" : "text-text"}>
              {c.text}
            </span>
            {c.evidence.length > 0 ? (
              <div className="ml-4 mt-0.5 flex flex-wrap items-center gap-1">
                {c.evidence.map((evRef) => (
                  <FactChip key={evRef} factRef={evRef} facts={facts} relations={relations} onInspect={onInspectFact} />
                ))}
              </div>
            ) : (
              <span className="ml-2 font-mono text-[11px] text-danger">
                ⚠ 无 evidence(INV-5 Goodhart 风险)
              </span>
            )}
            {tone === "rejected" && !c.whyNot && (
              <span className="ml-2 font-mono text-[11px] text-danger">⚠ 缺 why_not</span>
            )}
            {c.whyNot && (
              <div className="ml-4 text-[11px] italic text-text-faint">why_not: {c.whyNot}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 决策卡。五必显项逐项落地(41 §3.1):
 * ① chosen + rejected(rejected 非空且每条带 why_not)
 * ② riskTier / urgency 两枚徽章并排(正交,不合并)
 * ③ 证据 fact chips(含 relation rationale)
 * ④ relation 上下游(派生 task + supersede 链)
 * ⑤ provenance 三字段 {runtime, sessionId, boundAt} + 原文追溯入口
 */
export function VerdictCard({
  d,
  decisions,
  facts,
  tasks,
  relations,
  onTrace,
  onCallAgent,
  onDecide,
  onInspectFact,
  readOnly = false,
}: {
  d: DecisionRow;
  decisions: DecisionRow[];
  facts: FactRef[];
  tasks: TaskRow[];
  relations: RelationEdge[];
  onTrace: (sessionId: string) => void;
  onCallAgent?: (cmd: string) => void;
  onDecide: (id: string, action: "accept" | "reject" | "defer") => void;
  onInspectFact: (factRef: string) => void;
  readOnly?: boolean;
}) {
  const cov = coverageOf(d, facts);
  const derived = derivedTasks(d, relations, tasks);
  const chain = supersedeChain(d, relations);
  // 评审深度提示:riskTier 驱动(E50 防意外:GUI 只提示不强拦)
  const deepHint = d.riskTier === "high";
  const quickHint = d.riskTier === "low";

  // 决策就绪信号灯(41 §3.1a)
  const signals = computeReadinessSignals(d, facts);
  const worst = worstColor(signals);
  const hasAlert = worst !== "green";
  const conflictSignal = signals.find((s) => s.id === "conflict-marker" && s.color === "red");

  // 本会话态:冲突红灯 accept 被拒后的拒因渲染(不推进队列,卡片保留)
  const [rejection, setRejection] = useState<{ code: string; reason: string; detail: string[] } | null>(null);

  const handleAccept = () => {
    if (readOnly) return;
    if (conflictSignal) {
      // 冲突标记红灯:coordinator 前置预检拒绝(E52 R3)——渲染结构化拒因,不静默失败、不用 alert
      setRejection(buildConflictRejection(d));
      return;
    }
    // accept 成功:派生回写提示由父级 handleDecide 记入处理历史(本卡会出队,无法承载提示)
    onDecide(d.decisionId, "accept");
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      {/* 标题行:① id + state  ② 双轴徽章并排(正交) */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-text-faint">{d.decisionId}</span>
            <DecisionStateBadge state={d.state} />
            <span className="font-mono text-[11px] text-text-faint">{d.vertical}</span>
          </div>
          <div className="mt-1 text-[15px] font-semibold text-text">{d.title}</div>
          <div className="mt-0.5 text-[12px] italic text-text-muted">Q: {d.question}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <CopyContextButton
            compact
            buildText={() =>
              buildEntityJumpContext(
                `decision/${d.decisionId}`,
                relations,
                decisions,
                facts,
                tasks,
                "正在检查此 decision 的证据覆盖、就绪信号与关系上下游",
              )
            }
          />
          {/* 两轴徽章正交并排,不合并成单分 */}
          <RiskTierBadge tier={d.riskTier} />
          <UrgencyBadge urgency={d.urgency} />
        </div>
      </div>

      {/* 评审深度提示(E50:提示不强拦) */}
      {deepHint && (
        <div className="mt-2 rounded-md bg-stale/10 px-2.5 py-1.5 text-[11px] text-stale">
          <WarningCircle weight="bold" className="mr-1 inline text-[11px]" />
          高风险:建议拉满证据审查,放慢节奏充分核查后再决策批准。
        </div>
      )}
      {quickHint && (
        <div className="mt-2 rounded-md bg-surface-raised px-2.5 py-1.5 text-[11px] text-text-faint">
          低风险:可快速通过(因故进人队列,非典型)。
        </div>
      )}

      {/* 决策就绪信号灯(41 §3.1a):四盏机械信号灯必显,灯名 + 判定摘要 hover */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-raised/40 px-2.5 py-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-text-faint">决策就绪</span>
        {signals.map((s) => (
          <SignalLamp key={s.id} signal={s} />
        ))}
        {worst === "green" && (
          <span className="ml-auto text-[10px] text-success">全绿 · 直接决策批准正当</span>
        )}
      </div>

      {/* 黄/红警示条(41 §3.1a:不禁用按钮,只显式警示) */}
      {hasAlert && (
        <div
          className={`mt-2 rounded-md px-2.5 py-2 text-[11px] ${
            worst === "red"
              ? "bg-danger/10 text-danger"
              : "bg-stale/10 text-stale"
          }`}
        >
          <div className="flex items-center gap-1 font-semibold">
            {worst === "red" ? <BugBeetle weight="bold" className="text-[12px]" /> : <WarningCircle weight="bold" className="text-[12px]" />}
            {worst === "red" ? "红灯:决策批准前必须核查(承重风险)" : "黄灯:决策批准前建议核查"}
          </div>
          <ul className="mt-1 space-y-0.5 pl-4">
            {signals.filter((s) => s.color !== "green").map((s) => (
              <li key={s.id} className="flex gap-1">
                <span className={`shrink-0 ${s.color === "red" ? "text-danger" : "text-stale"}`}>●</span>
                <span className="font-mono text-[10px]">{s.label}:</span>
                <span>{s.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 归属展示来自 immutable attribution events；防自提自裁由写服务 fail-closed。 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-faint">
        <span>
          originator <span className="font-mono text-text-muted">{formatActorAxes(d.attribution.originator, "未知/—")}</span>
        </span>
        <span>
          latest actor <span className="font-mono text-text-muted">{formatActorAxes(d.attribution.latestActor, "待决策批准")}</span>
        </span>
      </div>

      {/* ① chosen + rejected(必显) */}
      <ClaimList title="chosen" items={d.chosen} tone="chosen" facts={facts} relations={relations} onInspectFact={onInspectFact} />
      <ClaimList title="rejected" items={d.rejected} tone="rejected" facts={facts} relations={relations} onInspectFact={onInspectFact} />

      {/* 覆盖度:承重论点 → 活 fact 可达(布尔,非分数) */}
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-text-faint">覆盖度</span>
        {cov.total === 0 ? (
          <span className="text-text-faint">无承重论点</span>
        ) : cov.covered === cov.total ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle weight="bold" /> {cov.covered}/{cov.total} 论点有可达 evidence
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-stale">
            <WarningCircle weight="bold" /> {cov.covered}/{cov.total} · 缺 {cov.gaps.join(", ")}
          </span>
        )}
      </div>

      {/* ④ relation 上下游:派生 task + supersede 链(P2 loop) */}
      {(derived.length > 0 || chain.supersedes.length > 0 || chain.supersededBy.length > 0) && (
        <div className="mt-2 rounded-md border border-border bg-surface-raised/50 p-2">
          <div className="flex items-center gap-1 text-[11px] font-semibold text-text-faint">
            <TreeStructure weight="bold" className="text-[12px]" /> relation 上下游(loop)
          </div>
          {derived.length > 0 && (
            <div className="mt-1 text-[11px]">
              <span className="text-text-faint">派生 task → </span>
              {derived.map((t) => (
                <span key={t.taskId} className="mr-2 inline-flex items-center gap-1 font-mono text-text-muted">
                  <span className="rounded bg-surface px-1">{t.taskId}</span>
                  <span className="font-sans text-text-faint">{t.title}</span>
                </span>
              ))}
            </div>
          )}
          {chain.supersedes.length > 0 && (
            <div className="mt-0.5 text-[11px]">
              <span className="text-text-faint">推翻(supersedes)→ </span>
              <span className="font-mono text-danger">{chain.supersedes.join(", ")}</span>
            </div>
          )}
          {chain.supersededBy.length > 0 && (
            <div className="mt-0.5 text-[11px]">
              <span className="text-text-faint">被推翻(superseded by)→ </span>
              <span className="font-mono text-danger">{chain.supersededBy.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      {/* ⑤ provenance 三字段 + 原文追溯入口 */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-text-faint">provenance:</span>
        {d.provenance?.map((p) => (
          <button
            key={p.sessionId}
            onClick={() => onTrace(p.sessionId)}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-px font-mono text-[11px] text-accent hover:bg-surface-raised"
            title={`runtime: ${p.runtime}\nsessionId: ${p.sessionId}\nboundAt: ${dateLabel(p.boundAt)}`}
          >
            <ArrowSquareOut weight="bold" className="text-[11px]" />
            {p.runtime}:{p.sessionId.slice(0, 8)}…
            <span className="font-sans text-text-faint">· {dateLabel(p.boundAt)}</span>
          </button>
        ))}
      </div>

      <div className="mt-1 text-[11px] text-text-faint">
        proposedAt: {dateLabel(d.proposedAt)} · lastChanged: {dateLabel(d.lastChangedAt)}
      </div>

      {/* 三操作视觉等权:accept 给 accent,但 reject/defer 同尺寸同可达,不藏菜单(反模式清单②) */}
      <div className="mt-3 flex gap-2 border-t border-border pt-3">
        <button
          onClick={handleAccept}
          disabled={readOnly}
          title={readOnly ? "只读 API 已接入；决策批准写面不在本切片" : "Accept"}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent/90"
        >
          <CheckCircle weight="bold" className="text-[13px]" />
          Accept
        </button>
        <button
          onClick={() => {
            if (!readOnly) onDecide(d.decisionId, "reject");
          }}
          disabled={readOnly}
          title={readOnly ? "只读 API 已接入；决策批准写面不在本切片" : "Reject"}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-text hover:border-danger/50 hover:bg-danger/5 hover:text-danger"
        >
          <ProhibitInset weight="bold" className="text-[13px]" />
          Reject
        </button>
        <button
          onClick={() => {
            if (!readOnly) onDecide(d.decisionId, "defer");
          }}
          disabled={readOnly}
          title={readOnly ? "只读 API 已接入；决策批准写面不在本切片" : "Defer"}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-text hover:border-stale/50 hover:bg-stale/5 hover:text-stale"
        >
          <ClockClockwise weight="bold" className="text-[13px]" />
          Defer
        </button>
      </div>

      {/* 冲突红灯 accept 被拒后的结构化拒因渲染(E52 R3:coordinator 前置预检拒,非 alert) */}
      {rejection && (
        <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 p-2.5 font-mono text-[11px] text-danger">
          <div className="flex items-center justify-between">
            <span className="font-semibold">✗ accept 被拒绝重来(coordinator 预检)</span>
            <button onClick={() => setRejection(null)} className="text-danger/70 hover:text-danger">✕</button>
          </div>
          <div className="mt-1">code: {rejection.code}</div>
          <div>{rejection.reason}</div>
          <div className="mt-1 space-y-0.5 text-danger/80">
            {rejection.detail.map((line, i) => (
              <div key={i}>· {line}</div>
            ))}
          </div>
        </div>
      )}

      {/* "呼叫 Agent 核查"动作(41 §3.1a):
          全绿 → 低调次级链接(直接决策批准才是正当主路径);
          黄/红 → 升为高亮推荐按钮(视觉权重 ≥ accept),但不弱化 reject/defer(它们在上行保持同尺寸)。
          决策批准权归人:agent 是核查助手不是决策通道(§3.1a 决策批准权归属) */}
      {onCallAgent && (
        hasAlert ? (
          <button
            onClick={() => onCallAgent(`harness decision ${d.decisionId} --check`)}
            className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-semibold ${
              worst === "red"
                ? "bg-danger/15 text-danger hover:bg-danger/25"
                : "bg-stale/15 text-stale hover:bg-stale/25"
            }`}
          >
            <Robot weight="bold" className="text-[13px]" />
            呼叫 Agent 核查(推荐)
            <span className="ml-1 text-[10px] font-normal opacity-70">agent 核查漂移/失效,经 CLI 代录决策</span>
          </button>
        ) : (
          <button
            onClick={() => onCallAgent(`harness decision ${d.decisionId}`)}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <PaperPlaneTilt weight="bold" className="text-[11px]" />
            或通过 CLI 与 Agent 讨论后决策批准(预填 /decisions)
          </button>
        )
      )}
    </div>
  );
}

// ============ inbox 队列壳层 ============
