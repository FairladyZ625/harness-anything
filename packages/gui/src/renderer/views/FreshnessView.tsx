import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { DecisionRow } from "../model/types";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import {
  freshnessCandidates,
  inDebtScopeCoverageRows,
  type FreshnessCandidate,
  type FreshnessReason,
} from "../model/freshness.ts";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 决策失真预警视图(原 O-08 风化视图):回答「哪些记录已经和现实对不上、先处理哪条」。
 * 候选按严重度分三档——被事实反驳(必须处置,warn 区)、缺少事实支撑(建议补证)、从未
 * 声明验证方式(自然老化);档内按决策分组收束(标准 §1.4 收束不堆叠,业主 2026-09-30
 * 截图验收):一组一行(决策标题 + 缺证断言数),默认只展开缺证最多的前几组,其余收成
 * 一行「还有 N 组 · 展开」;组内断言行用宽松两行形态(约 44px)——第一行断言结论,
 * 第二行决策 id · 断言 id · 反驳事实,不再把两行内容叠进 25px 单行。数据只来自
 * canonical coverageRows,判据见 model/freshness.ts。组间排序按缺证断言数降序(读面
 * 不提供失证时刻,组行不显示时间);行带 content-visibility:auto,离屏行由渲染器
 * 跳过布局与绘制。计数范围只含 decision.state ∈ {in_effect, proposed}(2026-08-29
 * 泽宇裁决):生命周期终态不算未覆盖债,分子分母同一口径,见 inDebtScopeCoverageRows。
 */

/** 分档展示顺序与 model/freshness.ts 的 REASON_RANK 一致:最危险的排最前。 */
const SECTION_ORDER: readonly FreshnessReason[] = ["refuted", "no-live-evidence", "fulfillment-undeclared"];

/** 成因 → 状态色档(标准 §3):反驳=红,缺证=琥珀,自然老化=灰蓝。 */
const REASON_TONE: Record<FreshnessReason, StatusTone> = {
  refuted: "bad",
  "no-live-evidence": "wait",
  "fulfillment-undeclared": "plan",
};

/** 每档默认展开的组数(缺证最多的前几组);其余组收进「还有 N 组 · 展开」。 */
const DEFAULT_OPEN_GROUPS = 3;

function ReasonTag({ reason }: { reason: FreshnessReason }) {
  return (
    <span data-testid={`freshness-reason-${reason}`}>
      <StatusTag tone={REASON_TONE[reason]} label={t(`views.freshnessView.reason.${reason}`)} />
    </span>
  );
}

/** 一个决策一组:同一成因档内该决策的全部失真候选。 */
interface DecisionGroup {
  readonly decisionId: string;
  readonly decisionTitle: string | null;
  readonly candidates: readonly FreshnessCandidate[];
}

/** 组排序:缺证断言最多的决策最急(页头「先处理哪条」指向它),同数按 id 稳定。 */
function groupByDecision(candidates: readonly FreshnessCandidate[]): DecisionGroup[] {
  const byDecision = new Map<string, FreshnessCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byDecision.get(candidate.decisionId);
    if (bucket) bucket.push(candidate);
    else byDecision.set(candidate.decisionId, [candidate]);
  }
  return [...byDecision.entries()]
    .map(([decisionId, group]) => ({
      decisionId,
      decisionTitle: group[0]!.decisionTitle,
      candidates: group,
    }))
    .sort(
      (left, right) =>
        right.candidates.length - left.candidates.length || left.decisionId.localeCompare(right.decisionId),
    );
}

/**
 * 组内一条断言:宽松两行 DenseRow(约 44px)——第一行断言结论,第二行
 * 决策 id · 断言 id · 反驳事实(可点直达);id 一律经 EntityRefLink(G10)。
 */
function FreshnessRow({
  candidate,
  onNavigateEntity,
}: {
  candidate: FreshnessCandidate;
  onNavigateEntity: (ref: string) => void;
}) {
  const decisionRef = `decision/${candidate.decisionId}`,
    meta: ReactNode[] = [
      <EntityRefLink
        key="decision"
        entityRef={decisionRef}
        onNavigate={onNavigateEntity}
        title={candidate.decisionTitle ?? candidate.decisionId}
      >
        {candidate.decisionId}
      </EntityRefLink>,
      <span key="claim" className="font-mono">
        {candidate.claimId}
      </span>,
    ];
  for (const ref of candidate.refutingFactRefs) {
    meta.push(
      <EntityRefLink key={ref} entityRef={ref} onNavigate={onNavigateEntity}>
        {ref}
      </EntityRefLink>,
    );
  }
  return (
    <div data-testid="freshness-row" className="cv-auto-3r">
      <DenseRow
        tag={<ReasonTag reason={candidate.reason} />}
        title={candidate.claimText ?? t("views.freshnessView.claimMissing")}
        relaxed
        reason={
          <>
            {meta.map((node, index) => (
              <span key={index}>
                {index > 0 ? <span aria-hidden> · </span> : null}
                {node}
              </span>
            ))}
          </>
        }
      />
    </div>
  );
}

/**
 * 组头(标准 §2.2 组标题一行):决策标题 + 缺证断言数 + 展开角。标题不带链接(组头的
 * 交互是展开/收起,决策直达在组内断言行的第二行);决策标题缺位时如实落到 id 链接。
 */
function GroupHeader({
  group,
  open,
  onToggle,
  onNavigateEntity,
}: {
  group: DecisionGroup;
  open: boolean;
  onToggle: () => void;
  onNavigateEntity: (ref: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5 border-t border-border py-2"
      data-testid={`freshness-group-${group.decisionId}`}
    >
      <h3 className="min-w-0 flex-1 truncate font-semibold text-text ui-body">
        {group.decisionTitle === null ? (
          <EntityRefLink
            entityRef={`decision/${group.decisionId}`}
            onNavigate={onNavigateEntity}
            className="font-semibold text-text ui-body hover:underline"
          >
            {group.decisionId}
          </EntityRefLink>
        ) : (
          <TitleText title={group.decisionTitle} />
        )}
      </h3>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`freshness-group-toggle-${group.decisionId}`}
        onClick={onToggle}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-xs font-mono tabular-nums text-text-muted ui-meta transition-colors duration-100 hover:text-text"
      >
        {t("views.freshnessView.groupClaims", { count: group.candidates.length })}
        <CaretDown
          weight="bold"
          aria-hidden
          className={`shrink-0 transition-transform duration-100 ${open ? "" : "-rotate-90"}`}
        />
      </button>
    </div>
  );
}

/**
 * 一档:组按缺证数降序,默认展开前 {@link DEFAULT_OPEN_GROUPS} 组,其余收成
 * 「还有 N 组 · 展开」一行(与工作页「已完成 N 个 · 展开」同一折叠语言)。
 */
function FreshnessSection({
  reason,
  groups,
  onNavigateEntity,
}: {
  reason: FreshnessReason;
  groups: readonly DecisionGroup[];
  onNavigateEntity: (ref: string) => void;
}) {
  // 用户点过哪组就按用户来(open 覆盖默认的前几组展开);未点过的组按位次定默认。
  const [userOpen, setUserOpen] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState(false);
  const visible = revealed ? groups : groups.slice(0, DEFAULT_OPEN_GROUPS);
  const hidden = groups.length - visible.length;
  return (
    <Section
      variant={reason === "refuted" ? "warn" : undefined}
      title={t(`views.freshnessView.section.${reason}.title`)}
      count={groups.reduce((total, group) => total + group.candidates.length, 0)}
      note={t(`views.freshnessView.section.${reason}.description`)}
    >
      {visible.map((group, index) => {
        const key = `${reason}/${group.decisionId}`,
          open = userOpen[key] ?? index < DEFAULT_OPEN_GROUPS;
        return (
          <div key={key}>
            <GroupHeader
              group={group}
              open={open}
              onToggle={() => setUserOpen((prev) => ({ ...prev, [key]: !open }))}
              onNavigateEntity={onNavigateEntity}
            />
            {open
              ? group.candidates.map((candidate) => (
                  <FreshnessRow
                    key={`${candidate.decisionId}/${candidate.claimId}`}
                    candidate={candidate}
                    onNavigateEntity={onNavigateEntity}
                  />
                ))
              : null}
          </div>
        );
      })}
      {hidden > 0 ? (
        <button
          type="button"
          data-testid={`freshness-more-${reason}`}
          onClick={() => setRevealed(true)}
          className="grid w-full grid-cols-[minmax(3rem,auto)_minmax(0,1fr)_auto] items-center gap-[7px] border-t border-border px-3 text-left text-text-faint ui-meta h-[25px]"
        >
          <span />
          <span className="truncate">{t("views.freshnessView.moreGroups", { count: hidden })}</span>
        </button>
      ) : null}
    </Section>
  );
}

/** 加载/错误/一切正常:一条细状态行,不画大框(标准 §1.5 空了就消失)。 */
function StatusLine({ tone, label, children }: { tone: StatusTone; label: string; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 py-2 text-text-faint ui-body" data-testid="freshness-status-line">
      <StatusTag tone={tone} label={label} />
      {children}
    </p>
  );
}

export function FreshnessView({
  decisions,
  coverageRows,
  relationState = "ready",
  onNavigateEntity,
}: {
  decisions: ReadonlyArray<DecisionRow>;
  coverageRows: ReadonlyArray<RelationCoverageRow>;
  relationState?: "ready" | "loading" | "error";
  onNavigateEntity: (ref: string) => void;
}) {
  const candidates = useMemo(() => freshnessCandidates(decisions, coverageRows), [decisions, coverageRows]);
  // 分母与候选同一口径(in_effect/proposed):生命周期终态的承重 claim 既不算未覆盖债,
  // 也不该仍算进"总承重 claim 数"——否则排除了分子却不排除分母,比例失真。
  const inScopeTotal = useMemo(
    () => inDebtScopeCoverageRows(decisions, coverageRows).length,
    [decisions, coverageRows],
  );
  const grouped = useMemo(() => {
    const groups = new Map<FreshnessReason, FreshnessCandidate[]>();
    for (const reason of SECTION_ORDER) groups.set(reason, []);
    for (const candidate of candidates) {
      groups.get(candidate.reason)?.push(candidate);
    }
    return new Map<FreshnessReason, DecisionGroup[]>(
      [...groups].map(([reason, list]) => [reason, groupByDecision(list)]),
    );
  }, [candidates]);
  // 页头结论行(标准 §1.1 先回答问题):多少条决策、多少条断言要处理、先处理哪条——
  // 「先处理」指向最危险档里缺证最多的那条决策。
  const firstUrgent = SECTION_ORDER.map((reason) => grouped.get(reason)?.[0]).find(Boolean) ?? null;
  const decisionsInvolved = new Set(candidates.map((candidate) => candidate.decisionId)).size;
  const basis = basisRevisionOf(coverageRows);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="freshness-view">
      <header className="shrink-0 border-b border-border px-5 py-3.5 md:px-7">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-[19px] font-semibold text-text">{t("views.freshnessView.title")}</h1>
          <span className="ui-meta text-text-muted" data-testid="freshness-counts">
            {t("views.freshnessView.headline", {
              claims: candidates.length,
              total: inScopeTotal,
              decisions: decisionsInvolved,
              first: firstUrgent?.decisionTitle ?? firstUrgent?.decisionId ?? "",
            })}
          </span>
          {basis !== null && (
            <span className="ml-auto shrink-0 font-mono ui-meta text-text-faint">
              {t("views.freshnessView.basis", { value: basis })}
            </span>
          )}
        </div>
        <p className="mt-1 ui-meta text-text-muted">{t("views.freshnessView.tagline")}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4 md:px-7">
        {relationState === "loading" ? (
          <StatusLine tone="plan" label={t("views.freshnessView.statusLoading")}>
            {t("views.freshnessView.loading")}
          </StatusLine>
        ) : relationState === "error" ? (
          <StatusLine tone="bad" label={t("views.freshnessView.statusError")}>
            {t("views.freshnessView.error")}
          </StatusLine>
        ) : candidates.length === 0 ? (
          // 空态必须是明确的「没有待处置项」,不是空白页;与加载/错误态分开,不冒充。
          <StatusLine tone="done" label={t("views.freshnessView.statusOk")}>
            {t("views.freshnessView.empty")}
          </StatusLine>
        ) : (
          <div data-testid="freshness-rows" className="max-w-[1100px]">
            {SECTION_ORDER.map((reason) => {
              const groups = grouped.get(reason);
              if (!groups || groups.length === 0) return null;
              return (
                <FreshnessSection key={reason} reason={reason} groups={groups} onNavigateEntity={onNavigateEntity} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 与 readiness-signals 的 basisSummary 同一纪律:报出判据所基于的投影修订号。 */
function basisRevisionOf(rows: ReadonlyArray<RelationCoverageRow>): number | null {
  const revisions = [...new Set(rows.flatMap((row) => (row.basisRevision === undefined ? [] : [row.basisRevision])))];
  return revisions.length === 1 ? revisions[0] : null;
}
