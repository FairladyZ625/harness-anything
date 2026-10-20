import { SegCtl } from "../primitives/SegCtl.tsx";
import { Button } from "../primitives/Button.tsx";
import { useEffect, useRef, useState } from "react";
import { Eye } from "@phosphor-icons/react";
import type { AgentDeclarationV1, RuntimeEffort } from "@harness-anything/daemon/protocol";
import type { RuntimeInstanceSummary } from "@harness-anything/daemon/protocol";
import { agentRuntimeKindMatches, runtimeEffortValues } from "@harness-anything/daemon/protocol";
import type {
  AgentEntityAvailableRow,
  AgentEntityDetail,
  AgentSkillRow,
  SquadEntityAvailableRow,
} from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { runtimeModelCandidates } from "../../model/runtime-models.ts";
import { RUNTIME_KIND_IDS } from "../../runtime-provider-planes.ts";
import { sessionStatusDot, type SessionStatus } from "../../sessions-model.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { ViewInGraphButton } from "../ViewInGraphButton.tsx";
import { ActionError } from "./ActionError.tsx";
import type { SettingsRoleRef } from "./DegradedEntityCard.tsx";
import { SkillEditorModal, type ViewingSkill } from "./SkillEditorModal.tsx";
import { AddChip, Avatar, Card, ChipZone, Hint, KindDot, LiveDot, Sect } from "./parts.tsx";
import { Chip } from "../primitives/Chip.tsx";
import { TextInput } from "../primitives/TextInput.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import type { RuntimeDockRow } from "./useRuntimeWorkspace.ts";

export type AgentDraft = {
  readonly name: string;
  readonly role: "worker" | "commander" | "reviewer";
  /** One row per accepted runtime kind; empty model/effort use the instance defaults. */
  readonly runtimes: readonly { readonly type: string; readonly model: string; readonly effort: RuntimeEffort | "" }[];
  readonly preset: string;
  readonly skills: readonly { readonly id: string; readonly path: string }[];
  readonly instructions: string;
  readonly prompts: readonly string[];
  // Optional declaration facets the editor does not render controls for still round-trip.
  readonly instance: string;
  readonly permissionMode: AgentDeclarationV1["permissionMode"] | "";
};
export const agentDraftFrom = (detail: AgentEntityDetail): AgentDraft => ({
  name: detail.name,
  role: detail.role,
  runtimes: detail.runtimes.map((target) => ({
    type: target.type,
    model: target.model ?? "",
    effort: target.effort ?? "",
  })),
  preset: detail.preset ?? "",
  skills: detail.skills,
  instructions: detail.instructions,
  prompts: detail.prompts,
  instance: detail.instance ?? "",
  permissionMode: detail.permissionMode ?? "",
});
export function agentDeclarationFrom(id: string, draft: AgentDraft): AgentDeclarationV1 {
  return {
    schema: "agent-declaration/v1",
    id,
    name: draft.name.trim(),
    instructions: draft.instructions,
    runtimes: draft.runtimes.map((target) => ({
      type: target.type,
      ...(target.model.trim() ? { model: target.model.trim() } : {}),
      ...(target.effort ? { effort: target.effort } : {}),
    })),
    role: draft.role,
    ...(draft.skills.length ? { skills: draft.skills } : {}),
    ...(draft.prompts.filter((prompt) => prompt.trim()).length
      ? { prompts: draft.prompts.map((prompt) => prompt.trim()).filter(Boolean) }
      : {}),
    ...(draft.preset.trim() ? { preset: draft.preset.trim() } : {}),
    ...(draft.instance.trim() ? { instance: draft.instance.trim() } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
  } as AgentDeclarationV1;
}
export const agentDraftDirty = (detail: AgentEntityDetail, draft: AgentDraft): boolean =>
  JSON.stringify(agentDraftFrom(detail)) !== JSON.stringify(draft);

type Props = {
  readonly detail: AgentEntityDetail;
  readonly row: AgentEntityAvailableRow | null;
  readonly squads: readonly SquadEntityAvailableRow[];
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly availableSkills?: readonly AgentSkillRow[];
  readonly presets?: readonly { readonly id: string; readonly title: string; readonly description: string }[];
  readonly busy: boolean;
  readonly onSave: (declaration: AgentDeclarationV1) => void;
  readonly onDispatch: (mission: string) => void;
  readonly onSelectRuntime: (instanceId: string) => void;
  readonly onSelectAgent: (agentId: string) => void;
  /** 统一「在关系图中查看」入口(task_89d324b5);缺省不渲染。 */
  readonly onFocusGraph?: (ref: string) => void;
  /**
   * 声明保存等动作的失败原因(含 daemon 返回的 hint):就在保存按钮旁显示,
   * 不再把原因只留在页首的通用错误条里(标准 §2.5 表单)。
   */
  readonly actionError?: string | null;
  /** 结论行(标准 §2.2 结论在上)的数据面:设置键把该 Agent 当什么角色调用。 */
  readonly conclusionRefs?: readonly SettingsRoleRef[];
  /** 最近一次派工(视图的相关派工轮次投影);null = 无记录。 */
  readonly lastDispatch?: {
    readonly status: string;
    readonly taskTitle: string | null;
    readonly startedAt: string;
  } | null;
  /**
   * 最近会话(原右侧 IdentityInspector 的相关会话段并入详情,业主 2026-10-06 密度
   * 反馈:右栏与详情重复的字段只留详情一处);不传就不渲染该段。会话按最近一页读取,
   * `sessionsHasMore` 为真时段尾给「加载更多」放大窗口。
   */
  readonly sessions?: readonly RuntimeDockRow[];
  readonly sessionsHasMore?: boolean;
  readonly loadingMoreSessions?: boolean;
  readonly onMoreSessions?: () => void;
  readonly onOpenSession?: (runtimeSessionId: string) => void;
  /** 退役入口:详情卡只发起对话框,写入由 view 接 daemon 写路;退役身份不再给入口。 */
  readonly onRetire?: () => void;
  /** 删除入口:同上。 */
  readonly onDelete?: () => void;
  /** 本地可算的引用面标签(Squad 位次、设置角色键、派工历史);非空时删除禁用并说明只能退役。 */
  readonly deleteBlockedBy?: readonly string[];
};
export function AgentCard({
  detail,
  row,
  squads,
  instances,
  availableSkills = [],
  presets = [],
  busy,
  onSave,
  onDispatch,
  onSelectRuntime,
  onSelectAgent,
  onFocusGraph,
  actionError = null,
  conclusionRefs = [],
  lastDispatch = null,
  sessions,
  sessionsHasMore = false,
  loadingMoreSessions = false,
  onMoreSessions,
  onOpenSession,
  onRetire,
  onDelete,
  deleteBlockedBy = [],
}: Props) {
  const [draft, setDraft] = useState<AgentDraft>(() => agentDraftFrom(detail)),
    [runtimeListOpen, setRuntimeListOpen] = useState(false),
    [skillSearch, setSkillSearch] = useState(""),
    [presetSearch, setPresetSearch] = useState(""),
    [viewingSkill, setViewingSkill] = useState<ViewingSkill | null>(null);
  // 技能编辑弹窗随退场动画常驻:关闭时 viewingSkill 已置空,持住最近一份供退场渲染。
  const lastViewingSkill = useRef(viewingSkill);
  if (viewingSkill !== null) lastViewingSkill.current = viewingSkill;
  const heldViewingSkill = lastViewingSkill.current;
  useEffect(() => {
    setDraft(agentDraftFrom(detail));
  }, [detail]);
  const patch = (value: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...value }));
  const compatible = instances.filter(
    (instance) => instance.enabled && agentRuntimeKindMatches(draft.runtimes, instance.kindId),
  );
  const patchRuntime = (
      kindId: string,
      value: Partial<{ readonly model: string; readonly effort: RuntimeEffort | "" }>,
    ) =>
      patch({
        runtimes: draft.runtimes.map((target) => (target.type === kindId ? { ...target, ...value } : target)),
      }),
    toggleRuntime = (kindId: string) => {
      const selected = draft.runtimes.some((target) => target.type === kindId),
        runtimes: AgentDraft["runtimes"] = selected
          ? draft.runtimes.filter((target) => target.type !== kindId)
          : [...draft.runtimes, { type: kindId, model: "", effort: "" }];
      patch({
        runtimes,
        // A pinned instance only stays valid while its kind still matches a selected row.
        instance:
          draft.instance &&
          instances.some(
            (entry) =>
              entry.enabled && entry.instanceId === draft.instance && agentRuntimeKindMatches(runtimes, entry.kindId),
          )
            ? draft.instance
            : "",
      });
    },
    modelsForKind = (kindId: string) => {
      // A resolved instance pin narrows that kind's model options to the pinned instance's own
      // catalog: the union of every enabled instance of the kind lets a sibling instance's model
      // ride the declaration, which the daemon rejects as agent_instance_incompatible. An
      // unpinned kind — or a pin of a different kind — keeps the kind's full union.
      const pinned = draft.instance
        ? instances.find((entry) => entry.enabled && entry.instanceId === draft.instance && entry.kindId === kindId)
        : undefined;
      return [
        ...new Set(
          (pinned ? [pinned] : instances.filter((entry) => entry.enabled && entry.kindId === kindId)).flatMap(
            (entry) => entry.models,
          ),
        ),
      ].sort();
    },
    filteredSkills = availableSkills.filter(
      (skill) =>
        !draft.skills.some((selected) => selected.id === skill.id) &&
        `${skill.id} ${skill.path} ${skill.source}`.toLowerCase().includes(skillSearch.trim().toLowerCase()),
    ),
    filteredPresets = presets.filter((preset) =>
      `${preset.id} ${preset.title} ${preset.description}`.toLowerCase().includes(presetSearch.trim().toLowerCase()),
    );
  const referencing = squads.filter((squad) => squad.leader === detail.id || squad.workers.includes(detail.id));
  // 声明角色与被当作什么角色调用:设置键(defaultWorker/…)与 Squad 位次是两处调用面;
  // 声明与调用不一致时用琥珀标签点出,一致的引用不额外强调(原 EntityConclusion 判据)。
  const calledAs: readonly { readonly label: string; readonly role: "worker" | "reviewer" | "commander" }[] = [
    ...conclusionRefs.map((ref) => ({ label: `roles.${ref.key}`, role: ref.role })),
    ...referencing.map((squad) => ({
      label: squad.name,
      role: squad.leader === detail.id ? ("commander" as const) : ("worker" as const),
    })),
  ];
  const mismatch = calledAs.some((call) => call.role !== draft.role);
  const dirty = agentDraftDirty(detail, draft);
  // 退役身份:结论行改说退役事实(接替者可点),派工与保存停用——daemon 对退役声明的
  // 派工与重装都会拒绝,这里不让用户走到那一步。
  const retired = detail.retirement !== null,
    deleteBlocked = deleteBlockedBy.length > 0;
  return (
    <div data-testid={`agent-card-${detail.id}`}>
      <Card>
        {/* 详情结论与身份并入卡头(S5 身份只写一遍):原独立结论条(EntityConclusion)与
            面包屑各画一遍的名称/角色/被谁引用,收敛到这一个头块;testid 随结论内容迁移。 */}
        <div data-testid="agent-detail-conclusion" className="flex items-start gap-3 px-3.5 py-3">
          <Avatar id={detail.id} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusTag
                tone={retired ? "cancel" : "neutral"}
                label={t(retired ? "agentRuntime.retiredTag" : "agentRuntime.detailAvailable")}
              />
              <input
                aria-label={t("agentRuntime.agentName")}
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="min-w-[200px] rounded border border-transparent bg-transparent px-1 py-px ui-prose font-bold text-text outline-none hover:border-border-strong focus-visible:border-accent focus-visible:bg-surface"
              />
              <EntityRefLink
                entityRef={`agent/${detail.id}`}
                onNavigate={() => onSelectAgent(detail.id)}
                title={detail.id}
                className="font-mono ui-micro text-text-faint hover:text-accent hover:underline"
              />
              {row && (
                <StatusTag
                  tone="neutral"
                  mono
                  tip={t("agentRuntime.layerTip", { layer: row.layer })}
                  label={row.layer}
                />
              )}
              {/* 统一「在关系图中查看」入口(task_89d324b5):agent 是图节点 kind。 */}
              <ViewInGraphButton
                entityRef={`agent/${detail.id}`}
                onFocusGraph={onFocusGraph}
                testId="agent-view-in-graph"
                className={
                  "ml-auto flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 ui-micro " +
                  "text-text-muted hover:border-border-strong hover:text-text"
                }
              />
            </div>
            {retired && detail.retirement !== null && (
              <p
                data-testid="agent-retirement-line"
                className="flex flex-wrap items-center gap-x-2 gap-y-1 ui-meta text-text-muted"
              >
                {t("agentRuntime.retiredAt", {
                  time:
                    formatTime(detail.retirement.retiredAt, { style: "month-day-time" }) ?? detail.retirement.retiredAt,
                })}
                <span>· {detail.retirement.reason}</span>
                {detail.retirement.successor !== undefined && (
                  <span>
                    {t("agentRuntime.retiredSuccessorPrefix")}
                    <EntityRefLink
                      entityRef={`agent/${detail.retirement.successor}`}
                      onNavigate={() => onSelectAgent(detail.retirement!.successor!)}
                      title={detail.retirement.successor}
                      className="font-mono ui-meta text-accent hover:underline"
                    />
                  </span>
                )}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <SegCtl
                label={t("agentRuntime.role")}
                value={draft.role}
                onChange={(role) => patch({ role })}
                options={[
                  {
                    value: "worker" as const,
                    label: t("agentRuntime.roleWorker"),
                    tip: t("agentRuntime.roleWorkerTip"),
                  },
                  {
                    value: "commander" as const,
                    label: t("agentRuntime.roleCommander"),
                    tip: t("agentRuntime.roleCommanderTip"),
                  },
                  {
                    value: "reviewer" as const,
                    label: t("agentRuntime.roleReviewer"),
                    tip: t("agentRuntime.roleReviewerTip"),
                  },
                ]}
              />
              <Hint>{t("agentRuntime.roleModelDecoupled")}</Hint>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="flex flex-wrap items-center gap-1.5 ui-meta text-text-muted">
                {calledAs.length === 0 ? (
                  t("agentRuntime.notReferenced")
                ) : (
                  <>
                    {t("agentRuntime.calledAsPrefix")}
                    {calledAs.map((call) => (
                      <span
                        key={call.label}
                        className="flex items-center gap-1 rounded-xs border border-border px-1.5 py-px"
                      >
                        <span className="font-mono ui-meta">{call.label}</span>
                        <span className="ui-meta text-text-faint">· {roleWord(call.role)}</span>
                      </span>
                    ))}
                  </>
                )}
              </span>
              {mismatch ? (
                <StatusTag
                  tone="wait"
                  label={t("agentRuntime.roleMismatch", {
                    declared: roleWord(draft.role),
                    called: roleWord(calledAs.find((call) => call.role !== draft.role)!.role),
                  })}
                />
              ) : null}
              <span className="ml-auto font-mono ui-meta text-text-faint">
                {lastDispatch === null || lastDispatch === undefined
                  ? t("agentRuntime.noDispatch")
                  : t("agentRuntime.lastDispatch", {
                      status: lastDispatch.status,
                      task: lastDispatch.taskTitle ?? "",
                      time: formatTime(lastDispatch.startedAt, { style: "month-day-time" }) ?? lastDispatch.startedAt,
                    })}
              </span>
            </div>
          </div>
        </div>

        {/* 详情宽屏两栏(业主 2026-10-06 密度反馈,标准 §1.9-⑤ 容器查询):Instructions
            占左主栏,Skills/Preset/最近会话靠右;首屏同时看到正文与配置面,不用滚动。
            分栏只看本容器宽度(<960px 单列),不写死视口断点。 */}
        <div className="@container">
          <div
            className="grid grid-cols-1 @min-[960px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]
              @min-[960px]:gap-x-6"
          >
            <div>
              <Sect
                title={t("agentRuntime.instructions")}
                desc={t("agentRuntime.instructionsDesc")}
                right={
                  <span className="font-mono">{t("agentRuntime.charCount", { count: draft.instructions.length })}</span>
                }
              >
                <p className="mb-1.5 ui-micro text-text-faint">{t("agentRuntime.instructionsHint")}</p>
                <textarea
                  aria-label={t("agentRuntime.instructions")}
                  data-testid="agent-instructions"
                  value={draft.instructions}
                  onChange={(event) => patch({ instructions: event.target.value })}
                  className="rt-instr"
                />
              </Sect>
            </div>
            <div>
              <Sect title={t("agentRuntime.skills")} desc={t("agentRuntime.skillsDesc")}>
                <ChipZone>
                  {draft.skills.length ? (
                    draft.skills.map((skill) => {
                      // 查看与删除解耦(task_5dfe382f):点药丸正文打开详情浮层,只有 × 热区删除。
                      const matching = availableSkills.find(
                        (available) => available.path === skill.path || available.id === skill.id,
                      );
                      return (
                        <Chip
                          key={skill.path}
                          tone="mono"
                          tip={skill.path}
                          onClick={() => setViewingSkill({ id: skill.id, path: skill.path, source: matching?.source })}
                          onRemove={() =>
                            patch({ skills: draft.skills.filter((selected) => selected.path !== skill.path) })
                          }
                          removeLabel={t("agentRuntime.skillModal.removeSkill")}
                        >
                          {skill.id}
                        </Chip>
                      );
                    })
                  ) : (
                    <Empty>{t("agentRuntime.noSkills")}</Empty>
                  )}
                </ChipZone>
                <div className="mt-2 grid gap-1.5">
                  <TextInput
                    label={t("agentRuntime.skillSearch")}
                    testId="agent-skill-search"
                    mono
                    value={skillSearch}
                    onChange={setSkillSearch}
                    placeholder={t("agentRuntime.skillSearchPlaceholder")}
                  />
                  {skillSearch.trim() && (
                    <div className="bounded-content overflow-y-auto rounded border border-border bg-surface p-1">
                      {filteredSkills.length ? (
                        filteredSkills.map((skill) => (
                          <div
                            key={skill.path}
                            className="flex w-full items-center gap-1 rounded px-2 py-1 hover:bg-surface-raised"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                patch({ skills: [...draft.skills, { id: skill.id, path: skill.path }] });
                                setSkillSearch("");
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <b className="font-mono ui-micro">{skill.id}</b>
                              <StatusTag tone="neutral" mono label={skill.source} />
                              <span className="min-w-0 truncate font-mono ui-micro text-text-faint">{skill.path}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={t("agentRuntime.skillModal.inspectSkill")}
                              data-tip={t("agentRuntime.skillModal.inspectSkill")}
                              data-testid="agent-skill-inspect"
                              onClick={() => setViewingSkill({ id: skill.id, path: skill.path, source: skill.source })}
                              className="grid size-6 shrink-0 place-items-center rounded text-text-faint hover:text-accent"
                            >
                              <Eye weight="bold" />
                            </button>
                          </div>
                        ))
                      ) : (
                        <Empty>{t("agentRuntime.noSkillMatches")}</Empty>
                      )}
                    </div>
                  )}
                </div>
              </Sect>

              <Sect title={t("agentRuntime.preset")} desc={t("agentRuntime.presetDesc")}>
                <div className="flex flex-wrap items-center gap-2">
                  {draft.preset && (
                    <Chip tone="mono" onClick={() => patch({ preset: "" })}>
                      {draft.preset} ×
                    </Chip>
                  )}
                  <TextInput
                    label={t("agentRuntime.presetSearch")}
                    testId="agent-preset"
                    mono
                    value={presetSearch}
                    onChange={setPresetSearch}
                    placeholder={t("agentRuntime.presetSearchPlaceholder")}
                  />
                  <Hint>{t("agentRuntime.presetHint")}</Hint>
                </div>
                {presetSearch.trim() && (
                  <div className="mt-1.5 bounded-content overflow-y-auto rounded border border-border bg-surface p-1">
                    {filteredPresets.length ? (
                      filteredPresets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            patch({ preset: preset.id });
                            setPresetSearch("");
                          }}
                          className="block w-full rounded px-2 py-1 text-left hover:bg-surface-raised"
                        >
                          <b className="ui-micro">{preset.title}</b>
                          <span className="ml-2 font-mono ui-micro text-text-faint">{preset.id}</span>
                        </button>
                      ))
                    ) : (
                      <Empty>{t("agentRuntime.noPresetMatches")}</Empty>
                    )}
                  </div>
                )}
              </Sect>

              {sessions !== undefined && (
                <Sect title={t("agentRuntime.recentSessions", { count: sessions.length })}>
                  {sessions.length === 0 ? (
                    <Empty>{t("agentRuntime.noSessions")}</Empty>
                  ) : (
                    /* 卡内滚动(业主 2026-10-10:714 条会话平铺把详情页撑到数万像素,
                       Prompts/Runtime 约束/操作被挤出首屏):会话行进共享 bounded-content
                       契约(同技能/预设搜索结果),封顶 --long-content-cap 后卡内滚动;
                       空列表保持 Empty,不造空滚动面板。读取只取最近一页,段尾「加载
                       更多」放大窗口,不随历史总量扇出。 */
                    <div
                      data-testid="agent-recent-sessions"
                      className="bounded-content overflow-y-auto rounded border border-border bg-surface p-1"
                    >
                      {sessions.map((row) => (
                        <DispatchSessionRow
                          key={row.runtimeSessionId}
                          row={row}
                          onOpenSession={onOpenSession ?? (() => undefined)}
                        />
                      ))}
                      {sessionsHasMore && (
                        <button
                          type="button"
                          data-testid="agent-recent-sessions-more"
                          disabled={loadingMoreSessions || onMoreSessions === undefined}
                          onClick={() => onMoreSessions?.()}
                          className="block w-full rounded px-2 py-1.5 text-center ui-micro text-accent
                          hover:bg-surface-raised disabled:text-text-faint"
                        >
                          {t(
                            loadingMoreSessions ? "agentRuntime.loadingMoreSessions" : "agentRuntime.loadMoreSessions",
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </Sect>
              )}
            </div>
          </div>
        </div>

        <Sect
          title={t("agentRuntime.prompts")}
          desc={t("agentRuntime.promptsDesc")}
          right={
            <AddChip onClick={() => patch({ prompts: [...draft.prompts, ""] })}>{t("agentRuntime.addPrompt")}</AddChip>
          }
        >
          {draft.prompts.length ? (
            draft.prompts.map((prompt, index) => (
              <div
                key={index}
                className="mb-1.5 flex items-center gap-2 rounded border border-border bg-surface px-2 py-1.5"
              >
                <span className="font-mono ui-micro text-text-faint">{String(index + 1).padStart(2, "0")}</span>
                <input
                  aria-label={t("agentRuntime.promptAt", { index: index + 1 })}
                  value={prompt}
                  onChange={(event) =>
                    patch({
                      prompts: draft.prompts.map((entry, position) =>
                        position === index ? event.target.value : entry,
                      ),
                    })
                  }
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-px font-mono ui-micro text-text outline-none focus-visible:border-accent"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => patch({ prompts: swap(draft.prompts, index, index - 1) })}
                  tip={t("agentRuntime.moveUp")}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === draft.prompts.length - 1}
                  onClick={() => patch({ prompts: swap(draft.prompts, index, index + 1) })}
                  tip={t("agentRuntime.moveDown")}
                >
                  ↓
                </Button>
                <Button size="sm" variant="primary" disabled={!prompt.trim()} onClick={() => onDispatch(prompt)}>
                  {t("agentRuntime.dispatchWithPrompt")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => patch({ prompts: draft.prompts.filter((_, position) => position !== index) })}
                  tip={t("agentRuntime.remove")}
                >
                  ✕
                </Button>
              </div>
            ))
          ) : (
            <Empty>{t("agentRuntime.noPrompts")}</Empty>
          )}
        </Sect>

        <Sect title={t("agentRuntime.runtimeConstraint")} desc={t("agentRuntime.runtimeConstraintDesc")}>
          <ChipZone>
            {draft.runtimes.map((target) => (
              <Chip
                key={target.type}
                tone="mono"
                onRemove={() => toggleRuntime(target.type)}
                removeLabel={t("agentRuntime.removeRuntime", { kind: target.type })}
              >
                {target.type}
              </Chip>
            ))}
            {RUNTIME_KIND_IDS.filter((kindId) => !draft.runtimes.some((target) => target.type === kindId)).map(
              (kindId) => (
                <AddChip key={kindId} onClick={() => toggleRuntime(kindId)}>
                  + {kindId}
                </AddChip>
              ),
            )}
          </ChipZone>
          {draft.runtimes.length === 0 && <Hint>{t("agentRuntime.anyRuntimeHint")}</Hint>}
          {draft.runtimes.map((target) => {
            const kindModels = modelsForKind(target.type),
              options =
                target.model === "" || kindModels.includes(target.model) ? kindModels : [...kindModels, target.model],
              // 会话型运行时(deepseek-harness)的 model 是候选清单(JSON 数组文本):
              // 下拉框放不下也不该让人从清单里「选一个」——改为完整逐项列出,编辑面
              // 保持只读,值原样随声明往返。
              candidates = runtimeModelCandidates(target.model);
            return (
              <div key={target.type} className="mt-1.5 flex flex-wrap items-center gap-2">
                <Chip tone="mono">{target.type}</Chip>
                {candidates === null ? (
                  <select
                    aria-label={t("agentRuntime.modelForKind", { kind: target.type })}
                    data-testid={`agent-runtime-model-${target.type}`}
                    value={target.model}
                    onChange={(event) => patchRuntime(target.type, { model: event.target.value })}
                    className="control"
                  >
                    <option value="">{t("agentRuntime.providerDefault")}</option>
                    {options.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span
                    data-testid={`agent-runtime-model-candidates-${target.type}`}
                    className="flex flex-wrap items-center gap-1"
                    title={target.model}
                  >
                    {candidates.map((model) => (
                      <StatusTag key={model} tone="neutral" mono label={model} />
                    ))}
                    <Hint>{t("agentRuntime.modelCandidatesHint", { count: candidates.length })}</Hint>
                  </span>
                )}
                <select
                  aria-label={t("agentRuntime.effortForKind", { kind: target.type })}
                  data-testid={`agent-runtime-effort-${target.type}`}
                  value={target.effort}
                  onChange={(event) => patchRuntime(target.type, { effort: event.target.value as RuntimeEffort | "" })}
                  className="control"
                >
                  <option value="">{t("agentRuntime.instanceEffort")}</option>
                  {runtimeEffortValues.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              aria-label={t("agentRuntime.instanceAssignment")}
              data-testid="agent-instance-select"
              value={draft.instance}
              onChange={(event) => patch({ instance: event.target.value })}
              className="control"
            >
              <option value="">{t("agentRuntime.instanceAuto")}</option>
              {compatible.map((entry) => (
                <option key={entry.instanceId} value={entry.instanceId}>
                  {entry.name} · {entry.defaultModel}
                </option>
              ))}
              {/* A declared instance that no longer resolves stays visible so the pin is explicit,
                  not silently rewritten — the daemon still rejects it as agent_instance_unavailable.
                  The option itself carries no raw id (dead-entity-id gate); the link beside the
                  select shows the pinned ref and stays navigable. */}
              {draft.instance && !compatible.some((entry) => entry.instanceId === draft.instance) && (
                <option value={draft.instance}>{t("agentRuntime.instanceUnavailable")}</option>
              )}
            </select>
            {draft.instance ? (
              <EntityRefLink
                entityRef={`provider/${draft.instance}`}
                onNavigate={() => onSelectRuntime(draft.instance)}
                title={draft.instance}
                className="font-mono ui-micro text-text-faint hover:text-accent hover:underline"
              />
            ) : null}
            <Hint>{t("agentRuntime.compatibleCount", { count: compatible.length })}</Hint>
            <Button size="sm" variant="ghost" onClick={() => setRuntimeListOpen(!runtimeListOpen)}>
              {t(runtimeListOpen ? "agentRuntime.collapse" : "agentRuntime.expand")}
            </Button>
          </div>
          {runtimeListOpen && (
            <div className="mt-2 rounded border border-border px-2 py-1.5">
              {compatible.length ? (
                compatible.map((instance) => (
                  <button
                    key={instance.instanceId}
                    type="button"
                    onClick={() => onSelectRuntime(instance.instanceId)}
                    className="flex w-full items-center gap-1.5 py-0.5 text-left ui-micro hover:text-accent"
                  >
                    <KindDot kind={instance.kindId} />
                    <span>{instance.name}</span>
                    <span className="font-mono ui-micro text-text-faint">{instance.defaultModel}</span>
                    <LiveDot state={instance.enabled ? "live" : "idle"} />
                  </button>
                ))
              ) : (
                <Empty>{t("agentRuntime.noCompatibleInstance")}</Empty>
              )}
            </div>
          )}
          <p className="mt-2 ui-micro text-text-faint">{t("agentRuntime.runtimeConstraintNote")}</p>
        </Sect>

        <Sect title={t("agentRuntime.actions")}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              testId={`dispatch-entry-${detail.id}`}
              disabled={retired}
              onClick={() => onDispatch("")}
            >
              {t("agentRuntime.dispatch")}
            </Button>
            {retired ? (
              <Hint>{t("agentRuntime.dispatchRetiredHint")}</Hint>
            ) : (
              <Hint>{t("agentRuntime.dispatchHint")}</Hint>
            )}
            <span className="flex-1" />
            {!retired && onRetire !== undefined && (
              <Button testId="agent-retire-entry" onClick={onRetire}>
                {t("agentRuntime.retireConfirm")}
              </Button>
            )}
            {onDelete !== undefined && (
              <Button
                variant="danger"
                testId="agent-delete-entry"
                disabled={deleteBlocked}
                tip={
                  deleteBlocked
                    ? t("agentRuntime.deleteReferencedTip", { refs: deleteBlockedBy.join("、") })
                    : undefined
                }
                onClick={onDelete}
              >
                {t("agentRuntime.deleteConfirm")}
              </Button>
            )}
            {deleteBlocked && onDelete !== undefined && <Hint>{t("agentRuntime.deleteReferencedShort")}</Hint>}
            {!retired && (
              <Button
                variant="primary"
                testId="agent-save"
                disabled={busy || !dirty || !draft.name.trim() || !draft.instructions.trim()}
                onClick={() => onSave(agentDeclarationFrom(detail.id, draft))}
              >
                {t(dirty ? "agentRuntime.saveDeclaration" : "agentRuntime.saved")}
              </Button>
            )}
            {retired && <Hint>{t("agentRuntime.saveRetiredHint")}</Hint>}
          </div>
          {actionError ? <ActionError>{actionError}</ActionError> : null}
        </Sect>
      </Card>
      {heldViewingSkill !== null && (
        <SkillEditorModal
          open={viewingSkill !== null}
          skill={heldViewingSkill}
          availableSkills={availableSkills}
          onClose={() => setViewingSkill(null)}
        />
      )}
    </div>
  );
}
const swap = <T,>(items: readonly T[], from: number, to: number): readonly T[] => {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
};

/** 最近会话段的按需渲染类:离屏行跳过布局与绘制(原 inspector 的会话行同款)。 */
const SESSION_ROW_CV = "cv-auto-2r";

/** 相关会话行(自原 IdentityInspector 迁入,业主 2026-10-06:右栏并入详情):状态点、
 * 谁在跑、任务标题与时间;点行进会话详情。 */
function DispatchSessionRow({
  row,
  onOpenSession,
}: {
  readonly row: RuntimeDockRow;
  readonly onOpenSession: (runtimeSessionId: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`agent-session-${row.runtimeSessionId}`}
      onClick={() => onOpenSession(row.runtimeSessionId)}
      className={[
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised",
        SESSION_ROW_CV,
      ].join(" ")}
    >
      <LiveDot state={sessionStatusDot[row.status as SessionStatus] ?? "idle"} tip={row.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate ui-micro">{row.agentName ?? row.instanceId}</span>
        <span className="block truncate font-mono ui-micro text-text-faint">
          {row.taskTitle ?? row.runtimeSessionId}
        </span>
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {formatTime(row.startedAt, { style: "time" }) ?? row.startedAt}
      </span>
    </button>
  );
}

const roleWord = (role: "worker" | "reviewer" | "commander"): string =>
  t(
    role === "commander"
      ? "agentRuntime.roleCommander"
      : role === "reviewer"
        ? "agentRuntime.roleReviewer"
        : "agentRuntime.roleWorker",
  );
