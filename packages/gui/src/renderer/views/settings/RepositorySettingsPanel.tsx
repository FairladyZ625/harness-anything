import { Toggle } from "../../components/primitives/Toggle.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { Section, Row, SettingSelect, type SelectorOption } from "../../components/ui/widgets";
import { useSettingsMutation, useSettingsQuery } from "../../settings-data.ts";
import { useCatalogSnapshot } from "../../catalog-data.ts";
import { agentEntityClient, isAvailableAgentEntityRow, type AgentEntityRow } from "../../agent-entity-client.ts";
import type { CatalogPresetRow } from "../../api-client.ts";
import {
  settingsGroupedRows,
  settingsPayloadFromDraft,
  settingsValueEquals,
  type SettingsDraft,
  type SettingsFieldRow,
  type RolePreferences,
  type SettingsFieldValue,
} from "../../settings-form.ts";
import {
  gateMappingDrafts,
  gateMappingRowIssues,
  gatesDraftValue,
  type GateMappingDraft,
} from "../../gate-mapping-form.ts";
import { GateMappingsEditor } from "./GateMappingsEditor.tsx";

/** closeout 门覆写的「默认」不是声明默认值,而是当前 profile 的基线(strict 全开)。 */
const CLOSEOUT_OVERRIDE_FIELDS: ReadonlySet<string> = new Set([
  "closeoutReview",
  "closeoutConsent",
  "closeoutFactDisposition",
  "closeoutCodeDoc",
]);

/** 「恢复默认」是低注意力的次要动作:无边框弱色文字,悬停才提亮,只在已修改时出现
 * (视觉基线 §1.7 轻重决定大小——不能比设置值本身还抢眼)。 */
const RESTORE_ACTION = "px-1 py-0.5 ui-meta text-text-faint underline-offset-2 hover:text-accent hover:underline";

/** 仓库设置面板:字段面、分组与逐项解释全部由 settings 动作契约 + 声明元数据派生,
 * 本文件只承担渲染、目录联动与提交。 */
export function RepositorySettingsPanel({
  repoId,
  onLocaleLoaded,
}: {
  readonly repoId: string | null;
  readonly onLocaleLoaded: (locale: "zh-CN" | "en-US") => void;
}) {
  const settingsQuery = useSettingsQuery(repoId);
  const settingsMutation = useSettingsMutation(repoId);
  const catalogQuery = useCatalogSnapshot(repoId);
  // 验收人取值面的已安装层:复用 agent 目录的共享缓存(与 AgentSquad/runtime workspace 同一
  // queryKey),不进 catalog 快照——实体写不应搅动 catalog digest。
  const agentsQuery = useQuery({
    queryKey: ["agents", repoId ?? "unselected"],
    queryFn: () => agentEntityClient.listAgents(repoId!),
    enabled: repoId !== null,
    staleTime: 4_000,
  });
  const [draft, setDraft] = useState<SettingsDraft>({}),
    // 门映射草稿独立于字段草稿:它是 authored settings.gates facet 的编辑面,不来自
    // values 扁平面(那里永远没有它);提交时以 gatesDraft 载荷走 ingress 铸造。
    [gateDrafts, setGateDrafts] = useState<readonly GateMappingDraft[] | null>(null),
    // 页内搜索:按名称/说明/后果过滤各组字段;搜索时高级组也照常展开。
    [query, setQuery] = useState(""),
    [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setDraft(settingsQuery.data.values);
    setGateDrafts(gateMappingDrafts(settingsQuery.data.settings.gates ?? []));
    onLocaleLoaded(settingsQuery.data.settings.locale);
  }, [settingsQuery.data]);

  // 仓库设置的字段面来自 settings 动作契约(目录快照的 settingsFields,daemon 与动作目录
  // 同一单源);分组与逐项解释(effect/默认值)同样由声明源投影进快照。目录选择器
  // (vertical/preset/profile/scaffold/reviewer/ciWorkflows)的选项来自 daemon 目录快照与
  // agent 目录共享缓存。两者都不是手打清单。目录读不到时选择器停用(fail closed),
  // 不回退成自由文本输入。
  const snapshot = catalogQuery.data,
    catalogBlocked = catalogQuery.isPending || !!catalogQuery.error,
    groups = settingsGroupedRows(snapshot?.settingsFields ?? [], snapshot?.settingsGroups ?? []),
    ciWorkflowFace = snapshot?.ciWorkflows ?? [],
    ciWorkflowValue = Array.isArray(draft.ciWorkflows) ? draft.ciWorkflows : [],
    verticalOptions = selectorOptions(
      (snapshot?.verticals ?? []).map((row) => ({
        value: row.id,
        label:
          row.available && row.valid ? row.id : t("views.settingsView.catalogUnavailableOption", { value: row.id }),
      })),
      typeof draft.defaultVertical === "string" ? draft.defaultVertical : undefined,
    ),
    presetOptions = selectorOptions(
      (snapshot?.presets ?? [])
        .filter((row) => row.verticalId === draft.defaultVertical)
        .map((row) => ({
          value: row.id,
          label: row.validity === "valid" ? `${row.id} · ${row.title}` : `${row.id} · ${row.validity}`,
        })),
      typeof draft.defaultPreset === "string" ? draft.defaultPreset : undefined,
    ),
    selectedPreset = (snapshot?.presets ?? []).find(
      (row) => row.id === draft.defaultPreset && row.verticalId === draft.defaultVertical,
    ),
    profileOptions = selectorOptions(
      cataloguedProfiles(selectedPreset).map((profile) => ({
        value: profile.id,
        label: `${profile.id} · ${profile.title}`,
      })),
      typeof draft.defaultProfile === "string" ? draft.defaultProfile : undefined,
    ),
    taskScaffoldOptions = selectorOptions(
      (snapshot?.scaffolds.task ?? []).map((value) => ({ value })),
      typeof draft.taskScaffold === "string" ? draft.taskScaffold : undefined,
    ),
    repositoryScaffoldOptions = selectorOptions(
      (snapshot?.scaffolds.repository ?? []).map((value) => ({ value })),
      typeof draft.repositoryScaffold === "string" ? draft.repositoryScaffold : undefined,
    ),
    reviewerOptions = selectorOptions(
      [
        // 空值选项显式存在:未设置是合法态(回落 bundled 默认),且避免「value 无匹配选项时
        // 浏览器显示第一个选项」造成的凭空选中。
        { value: "", label: t("views.settingsView.defaultReviewerUnsetOption") },
        ...reviewerFace(snapshot?.bundledAgents ?? [], agentsQuery.data ?? []),
      ],
      undefined,
    ),
    reviewerBlocked = agentsQuery.isPending || !!agentsQuery.error,
    gateDescriptor = snapshot?.gateMappings ?? null,
    gateIssues = gateDrafts !== null && gateDescriptor !== null ? gateMappingRowIssues(gateDrafts, gateDescriptor) : [],
    gatesPayload =
      gateDrafts !== null && settingsQuery.data
        ? gatesDraftValue(settingsQuery.data.settings.gates ?? [], gateDrafts)
        : undefined,
    // closeout 门覆写的生效默认值随 profile 走:strict 基线全开,standard 全关。
    closeoutOverrideDefault = settingsQuery.data?.settings.closeout.profile === "strict";

  const updateDraft = (field: string, value: SettingsFieldValue | undefined) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const chooseVertical = (verticalId: string) =>
    setDraft((current) => {
      const next = { ...current, defaultVertical: verticalId },
        presets = (snapshot?.presets ?? []).filter((row) => row.verticalId === verticalId && row.validity === "valid"),
        defaultPresetId = snapshot?.defaults.verticalId === verticalId ? snapshot.defaults.presetId : undefined,
        row =
          presets.find((candidate) => candidate.id === current.defaultPreset) ??
          presets.find((candidate) => candidate.id === defaultPresetId) ??
          presets[0];
      return row ? selectPreset(next, row.id, row) : next;
    });

  const choosePreset = (presetId: string) =>
    setDraft((current) => {
      const row = (snapshot?.presets ?? []).find(
        (candidate) => candidate.id === presetId && candidate.verticalId === current.defaultVertical,
      );
      return selectPreset(current, presetId, row);
    });

  /** 字段的生效默认值:closeout 覆写随 profile,其余取声明默认。 */
  const fieldDefault = (row: SettingsFieldRow): SettingsFieldValue | undefined =>
    CLOSEOUT_OVERRIDE_FIELDS.has(row.field) ? closeoutOverrideDefault : row.defaultValue;

  const fieldModified = (row: SettingsFieldRow): boolean =>
    row.field !== "roles" && !settingsValueEquals(draft[row.field], fieldDefault(row));

  const fieldControlProps = {
    draft,
    catalogBlocked,
    verticalOptions,
    presetOptions,
    profileOptions,
    taskScaffoldOptions,
    repositoryScaffoldOptions,
    reviewerOptions,
    reviewerBlocked,
    ciWorkflowOptions: [...ciWorkflowFace, ...ciWorkflowValue.filter((name) => !ciWorkflowFace.includes(name))],
    ciWorkflowCatalogued: new Set(ciWorkflowFace),
    chooseVertical,
    choosePreset,
    updateDraft,
  };

  /** 搜索命中判定:人话名称、说明、后果与字段名都可作为检索面。 */
  const matchesQuery = (row: SettingsFieldRow): boolean => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const haystack = [
      translatedFieldCopy(row.field, "Label") ?? humanizeField(row.field),
      translatedFieldCopy(row.field, "Description") ?? row.description ?? "",
      translatedFieldCopy(row.field, "Effect") ?? row.effect ?? "",
      row.field,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  };

  if (repoId === null)
    return (
      <Section title={t("views.settingsView.sectionRepository")}>
        <div className="p-4 ui-meta text-text-faint">{t("views.settingsView.repositoryTabNeedsRepo")}</div>
      </Section>
    );
  if (settingsQuery.error)
    return (
      <Section title={t("views.settingsView.sectionRepository")}>
        <div className="p-4 text-danger">{String(settingsQuery.error)}</div>
      </Section>
    );
  if (settingsQuery.isPending)
    return (
      <Section title={t("views.settingsView.sectionRepository")}>
        <div className="p-4 ui-meta text-text-faint">{t("views.settingsView.readingSettings")}</div>
      </Section>
    );
  return (
    <div className="flex flex-col gap-4">
      <Section
        title={t("views.settingsView.sectionRepository")}
        action={
          <Button
            // 门映射草稿有未解决的非法组合时整表不让提交——约束在界面上表达,
            // 不靠提交后报错。
            disabled={settingsMutation.isPending || gateIssues.length > 0}
            onClick={() =>
              settingsMutation.mutate({
                ...settingsPayloadFromDraft(draft, snapshot?.settingsFields ?? [], settingsQuery.data?.values),
                ...(gatesPayload !== undefined ? { gatesDraft: gatesPayload } : {}),
              })
            }
          >
            {settingsMutation.isPending
              ? t("views.settingsView.submitPending")
              : t("views.settingsView.submitToRepository")}
          </Button>
        }
      >
        <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
          <p className="ui-meta text-text-muted">{t("views.settingsView.principalOnlyNotice")}</p>
          <input
            type="search"
            aria-label={t("views.settingsView.searchPlaceholder")}
            placeholder={t("views.settingsView.searchPlaceholder")}
            data-testid="settings-search"
            className="w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1.5 ui-body text-text placeholder:text-text-faint"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {catalogQuery.error ? (
          <div className="px-3 py-2 ui-meta text-danger">
            {t("views.settingsView.catalogUnavailableHint", { error: String(catalogQuery.error) })}
          </div>
        ) : null}
        {agentsQuery.error ? (
          <div className="px-3 py-2 ui-meta text-danger">
            {t("views.settingsView.catalogUnavailableHint", { error: String(agentsQuery.error) })}
          </div>
        ) : null}
        {settingsMutation.error ? (
          <div className="px-3 py-2 ui-meta text-danger">{String(settingsMutation.error)}</div>
        ) : null}
      </Section>
      {groups.length === 0 ? (
        <Section title={t("views.settingsView.sectionRepository")}>
          <div className="p-4 ui-meta text-text-faint">{t("views.settingsView.readingSettings")}</div>
        </Section>
      ) : (
        groups.map((group) => {
          const rows = group.rows.filter(matchesQuery);
          if (rows.length === 0) return null;
          const searching = query.trim().length > 0,
            expanded = !group.advanced || advancedOpen || searching;
          return (
            <Section
              key={group.id || "ungrouped"}
              title={groupTitle(group.id)}
              action={
                group.advanced ? (
                  <Button testId="settings-advanced-toggle" onClick={() => setAdvancedOpen((open) => !open)}>
                    {expanded
                      ? t("views.settingsView.advancedCollapse")
                      : t("views.settingsView.advancedExpand", { count: group.rows.length })}
                  </Button>
                ) : undefined
              }
            >
              {groupDescription(group.id) ? (
                <p className="border-b border-border px-3 py-2 ui-meta text-text-muted">{groupDescription(group.id)}</p>
              ) : null}
              {expanded ? (
                <>
                  {/* 门映射编辑面归 CI 与门组:settings.gates facet 的导入与逐门适配。 */}
                  {group.id === "ci-gates" ? (
                    <>
                      <Row
                        label={t("views.settingsView.gatesSectionLabel")}
                        desc={t("views.settingsView.gatesSectionDescription")}
                      >
                        <Button
                          testId="settings-gates-import"
                          disabled={settingsMutation.isPending}
                          tip={t("views.settingsView.gatesFromDocumentDescription")}
                          onClick={() => settingsMutation.mutate({ gatesFromDocument: true })}
                        >
                          {t("views.settingsView.gatesFromDocumentLabel")}
                        </Button>
                      </Row>
                      <div className="border-b border-border px-3 py-2">
                        {gateDrafts === null || gateDescriptor === null ? (
                          <div className="ui-meta text-text-faint">{t("views.settingsView.readingSettings")}</div>
                        ) : (
                          <GateMappingsEditor
                            drafts={gateDrafts}
                            descriptor={gateDescriptor}
                            issues={gateIssues}
                            disabled={catalogBlocked || settingsMutation.isPending}
                            onChange={setGateDrafts}
                          />
                        )}
                      </div>
                    </>
                  ) : null}
                  {rows.map((row) => (
                    <SettingsFieldEntry
                      key={row.field}
                      row={row}
                      modified={fieldModified(row)}
                      defaultText={row.field === "roles" ? undefined : defaultValueText(fieldDefault(row))}
                      onRestore={() => updateDraft(row.field, fieldDefault(row))}
                    >
                      {renderFieldControl(row, fieldControlProps)}
                    </SettingsFieldEntry>
                  ))}
                </>
              ) : null}
            </Section>
          );
        })
      )}
    </div>
  );
}

/** 默认值的写法:开关读作开启/关闭,空集合与未设置各有其词,其余照值显示。 */
function defaultValueText(value: SettingsFieldValue | undefined): string {
  if (value === undefined) return t("views.settingsView.defaultReviewerUnsetOption");
  if (typeof value === "boolean") return t(value ? "views.settingsView.toggleOn" : "views.settingsView.toggleOff");
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("views.settingsView.defaultValueEmpty");
  return String(value);
}

/** 默认值常显在名称旁:没改过的项不必靠「没有已修改标记」反推。 */
function DefaultValueNote({ testId, text }: { readonly testId: string; readonly text: string }) {
  return (
    <span data-testid={testId} className="ui-meta font-normal text-text-faint">
      {t("views.settingsView.defaultValue", { value: text })}
    </span>
  );
}

/** 单个设置项:名称 + 默认值 + 已修改标记/恢复默认 + 控件 + 「它管什么 / 改了会怎样」两行说明;
 * 怎么填这类机制细节收在可展开的帮助里。 */
function SettingsFieldEntry({
  row,
  modified,
  defaultText,
  onRestore,
  children,
}: {
  readonly row: SettingsFieldRow;
  readonly modified: boolean;
  readonly defaultText: string | undefined;
  readonly onRestore: () => void;
  readonly children: ReactNode;
}) {
  const label = translatedFieldCopy(row.field, "Label") ?? humanizeField(row.field),
    description = translatedFieldCopy(row.field, "Description") ?? row.description ?? undefined,
    effect = translatedFieldCopy(row.field, "Effect") ?? row.effect ?? undefined,
    help = translatedFieldCopy(row.field, "Help");
  return (
    <Row
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span>{label}</span>
          {defaultText !== undefined ? (
            <DefaultValueNote testId={`settings-${row.field}-default`} text={defaultText} />
          ) : null}
          {modified ? (
            <>
              <span
                data-testid={`settings-${row.field}-modified`}
                className="rounded bg-accent/15 px-1.5 py-0.5 ui-micro font-medium text-accent"
              >
                {t("views.settingsView.modifiedChip")}
              </span>
              <button
                type="button"
                className={RESTORE_ACTION}
                data-testid={`settings-${row.field}-restore`}
                onClick={onRestore}
              >
                {t("views.settingsView.restoreDefault")}
              </button>
            </>
          ) : null}
        </span>
      }
      desc={
        <>
          {description ? <div>{description}</div> : null}
          {effect ? (
            <div className="mt-0.5">
              <span className="text-text-faint">{t("views.settingsView.effectPrefix")}</span>
              {effect}
            </div>
          ) : null}
          {help ? (
            <details className="mt-0.5" data-testid={`settings-${row.field}-help`}>
              <summary className="cursor-pointer hover:text-text">{t("views.settingsView.helpSummary")}</summary>
              <div className="mt-0.5">{help}</div>
            </details>
          ) : null}
        </>
      }
    >
      {children}
    </Row>
  );
}

function groupCopy(groupId: string, suffix: "label" | "description"): string | undefined {
  if (!groupId) return undefined;
  const key = `views.settingsView.settingsGroup.${groupId}.${suffix}` as MessageKey,
    translated = t(key);
  return translated === key ? undefined : translated;
}

function groupTitle(groupId: string): string {
  return groupCopy(groupId, "label") ?? groupId;
}

function groupDescription(groupId: string): string | undefined {
  return groupCopy(groupId, "description");
}

function translatedFieldCopy(field: string, suffix: "Label" | "Description" | "Effect" | "Help"): string | undefined {
  const key = `views.settingsView.${field}${suffix}` as MessageKey,
    translated = t(key);
  return translated === key ? undefined : translated;
}

function humanizeField(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/^./u, (letter) => letter.toUpperCase());
}

/** 枚举取值旁的人话解释;没有文案时只显示原值(chokepoint 测试会先红)。 */
function enumOptionLabel(field: string, value: string): string {
  const key = `views.settingsView.enum.${field}.${value}` as MessageKey,
    translated = t(key);
  return translated === key ? value : `${value} · ${translated}`;
}

interface FieldControlProps {
  readonly draft: SettingsDraft;
  readonly catalogBlocked: boolean;
  readonly verticalOptions: readonly SelectorOption[];
  readonly presetOptions: readonly SelectorOption[];
  readonly profileOptions: readonly SelectorOption[];
  readonly taskScaffoldOptions: readonly SelectorOption[];
  readonly repositoryScaffoldOptions: readonly SelectorOption[];
  readonly reviewerOptions: readonly SelectorOption[];
  readonly reviewerBlocked: boolean;
  readonly ciWorkflowOptions: readonly string[];
  readonly ciWorkflowCatalogued: ReadonlySet<string>;
  readonly chooseVertical: (verticalId: string) => void;
  readonly choosePreset: (presetId: string) => void;
  readonly updateDraft: (field: string, value: SettingsFieldValue | undefined) => void;
}

// 稳定 testId:测试与 e2e 探针引用的选择器/输入框沿用历史命名;未登记字段回落
// settings-<field>-select / settings-<field>-input 的通用命名。
const FIELD_TEST_IDS: Readonly<Record<string, string>> = {
  defaultVertical: "settings-vertical-select",
  defaultPreset: "settings-preset-select",
  defaultProfile: "settings-profile-select",
  taskScaffold: "settings-task-scaffold-select",
  repositoryScaffold: "settings-repository-scaffold-select",
  ciWorkflows: "settings-ciWorkflows",
};

/** 单字段的控件:widget 由契约类型派生;目录选择器/多选是 GUI 特有联动。 */
function renderFieldControl(
  row: { readonly field: string; readonly widget: string; readonly options: readonly string[] | null },
  props: FieldControlProps,
) {
  const { draft, catalogBlocked, updateDraft } = props,
    testId = FIELD_TEST_IDS[row.field];
  switch (row.widget) {
    case "role-selectors": {
      const roles = (draft.roles ?? {}) as RolePreferences;
      return (
        <div className="flex flex-col gap-3">
          {(["defaultWorker", "defaultCommander", "defaultReviewer"] as const).map((key) => {
            const modified = roles[key] != null;
            return (
              <div key={key}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ui-meta font-medium text-text-muted">{t(`views.settingsView.${key}Label`)}</span>
                  <DefaultValueNote testId={`settings-roles-${key}-default`} text={defaultValueText(undefined)} />
                  {modified ? (
                    <>
                      <span
                        data-testid={`settings-roles-${key}-modified`}
                        className="rounded bg-accent/15 px-1.5 py-0.5 ui-micro font-medium text-accent"
                      >
                        {t("views.settingsView.modifiedChip")}
                      </span>
                      <button
                        type="button"
                        className={RESTORE_ACTION}
                        data-testid={`settings-roles-${key}-restore`}
                        onClick={() => updateDraft("roles", { ...roles, [key]: null })}
                      >
                        {t("views.settingsView.restoreDefault")}
                      </button>
                    </>
                  ) : null}
                </div>
                <div className="ui-meta text-text-muted">{t(`views.settingsView.${key}Description`)}</div>
                <SettingSelect
                  label={t(`views.settingsView.${key}Label`)}
                  testId={`settings-${key}-select`}
                  value={roles[key] ?? ""}
                  disabled={props.catalogBlocked || props.reviewerBlocked}
                  options={selectorOptions(props.reviewerOptions, roles[key] ?? undefined)}
                  onChange={(value) => updateDraft("roles", { ...roles, [key]: value || null })}
                />
              </div>
            );
          })}
        </div>
      );
    }
    case "catalog-select": {
      const selector = catalogSelector(row.field, props);
      if (!selector) return <span className="ui-meta text-text-faint">{row.field}</span>;
      return (
        <SettingSelect
          label={row.field}
          testId={testId ?? `settings-${row.field}-select`}
          value={typeof draft[row.field] === "string" ? (draft[row.field] as string) : ""}
          disabled={selector.blocked}
          options={selector.options}
          onChange={selector.onChange}
        />
      );
    }
    case "catalog-multi-select":
      return (
        <SettingMultiCheckboxes
          testId={testId ?? `settings-${row.field}`}
          options={props.ciWorkflowOptions}
          catalogued={props.ciWorkflowCatalogued}
          value={Array.isArray(draft[row.field]) ? (draft[row.field] as readonly string[]) : []}
          disabled={catalogBlocked}
          onChange={(next) => updateDraft(row.field, next)}
        />
      );
    case "string-list": {
      const value = draft[row.field];
      return (
        <SettingLinesInput
          label={row.field}
          testId={testId ?? `settings-${row.field}-input`}
          value={Array.isArray(value) ? value : []}
          onChange={(next) => updateDraft(row.field, next)}
        />
      );
    }
    case "enum-select":
      return (
        <SettingSelect
          label={row.field}
          testId={testId ?? `settings-${row.field}-select`}
          value={typeof draft[row.field] === "string" ? (draft[row.field] as string) : ""}
          options={selectorOptions(
            (row.options ?? []).map((value) => ({ value, label: enumOptionLabel(row.field, value) })),
            typeof draft[row.field] === "string" ? (draft[row.field] as string) : undefined,
          )}
          onChange={(value) => updateDraft(row.field, value)}
        />
      );
    case "toggle":
      return (
        <Toggle
          label={row.field}
          checked={draft[row.field] === true}
          onChange={(enabled) => updateDraft(row.field, enabled)}
        />
      );
    case "number": {
      const value = draft[row.field];
      return (
        <SettingNumberInput
          label={row.field}
          testId={testId ?? `settings-${row.field}-input`}
          value={typeof value === "number" ? value : 1}
          onChange={(next) => updateDraft(row.field, next)}
        />
      );
    }
    default: {
      const value = draft[row.field];
      return (
        <input
          aria-label={row.field}
          data-testid={testId ?? `settings-${row.field}-input`}
          type="text"
          className="w-64 rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateDraft(row.field, event.currentTarget.value.trim())}
        />
      );
    }
  }
}

/** 目录选择器各字段各自的选项、联动与停用条件;字段不在注册表内时回落
 * nil(防御,正常不可达)。 */
function catalogSelector(
  field: string,
  props: FieldControlProps,
): {
  readonly options: readonly SelectorOption[];
  readonly onChange: (value: string) => void;
  readonly blocked: boolean;
} | null {
  switch (field) {
    case "defaultVertical":
      return { options: props.verticalOptions, onChange: props.chooseVertical, blocked: props.catalogBlocked };
    case "defaultPreset":
      return { options: props.presetOptions, onChange: props.choosePreset, blocked: props.catalogBlocked };
    case "defaultProfile":
      return {
        options: props.profileOptions,
        onChange: (value) => props.updateDraft(field, value),
        blocked: props.catalogBlocked,
      };
    case "taskScaffold":
      return {
        options: props.taskScaffoldOptions,
        onChange: (value) => props.updateDraft(field, value),
        blocked: props.catalogBlocked,
      };
    case "repositoryScaffold":
      return {
        options: props.repositoryScaffoldOptions,
        onChange: (value) => props.updateDraft(field, value),
        blocked: props.catalogBlocked,
      };
    default:
      return null;
  }
}

function SettingNumberInput({
  label,
  testId,
  value,
  onChange,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <input
      aria-label={label}
      data-testid={testId}
      type="number"
      min={1}
      step={1}
      className="w-36 rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
      value={value}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isSafeInteger(next) && next > 0) onChange(next);
      }}
    />
  );
}

function SettingLinesInput({
  label,
  testId,
  value,
  onChange,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  const [text, setText] = useState(value.join("\n")),
    joined = value.join("\n");
  useEffect(() => {
    if (lines(text).join("\n") !== joined) setText(joined);
  }, [joined]);
  return (
    <textarea
      aria-label={label}
      data-testid={testId}
      rows={Math.max(2, value.length + 1)}
      placeholder={t("views.settingsView.worktreeSetupPlaceholder")}
      className="w-80 rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
      value={text}
      onChange={(event) => {
        setText(event.currentTarget.value);
        onChange(lines(event.currentTarget.value));
      }}
    />
  );
}

function lines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** string-array 的目录多选:每个取值一个 checkbox,全不勾 = 空集合(合法且有意义:
 * 退出 CI 见证)。当前值不在目录里时照实列出并保持勾选,提交不凭空丢值;
 * 目录不可达时整体停用,不回退成自由文本输入。 */
function SettingMultiCheckboxes({
  testId,
  options,
  catalogued,
  value,
  disabled,
  onChange,
}: {
  readonly testId: string;
  readonly options: readonly string[];
  readonly catalogued: ReadonlySet<string>;
  readonly value: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (next: readonly string[]) => void;
}) {
  return (
    <div className="flex max-w-md flex-wrap justify-end gap-x-4 gap-y-1" data-testid={testId}>
      {options.map((option) => (
        <label key={option} className="inline-flex items-center gap-1.5 font-mono ui-meta text-text">
          <input
            type="checkbox"
            data-testid={`${testId}-option-${option}`}
            disabled={disabled}
            checked={value.includes(option)}
            onChange={(event) =>
              onChange(event.currentTarget.checked ? [...value, option] : value.filter((entry) => entry !== option))
            }
          />
          {catalogued.has(option) ? option : t("views.settingsView.catalogMissingOption", { value: option })}
        </label>
      ))}
    </div>
  );
}

/** 验收人取值面:已安装层 ∪ bundled 层,按值去重且安装层覆盖同名 bundled(与
 * readAgentDeclarationResolution 的解析顺序一致)。安装层的 degraded 行不进取值面——
 * 指向它的既有值由 selectorOptions 的当前值并集照实保留。 */
function reviewerFace(
  bundled: readonly string[],
  agents: readonly AgentEntityRow[],
): ReadonlyArray<{ readonly value: string; readonly label?: string }> {
  const face = new Map<string, string>();
  for (const row of agents) if (isAvailableAgentEntityRow(row)) face.set(row.id, `${row.id} · ${row.name}`);
  for (const id of bundled) if (!face.has(id)) face.set(id, id);
  return [...face].map(([value, label]) => ({ value, label }));
}

/** 目录取值面 + 当前值取并集:当前值不在目录里也照实显示并保留可提交,
 * 否则一个指向尚未创建文件/未登记 preset 的既有设置会凭空变成空选择。 */
function selectorOptions(
  catalogued: ReadonlyArray<{ readonly value: string; readonly label?: string }>,
  current: string | undefined,
): readonly SelectorOption[] {
  const options = catalogued.map((row) => ({ value: row.value, label: row.label ?? row.value }));
  if (current && !options.some((option) => option.value === current))
    options.push({ value: current, label: t("views.settingsView.catalogMissingOption", { value: current }) });
  return options;
}

/** preset/profile 一致性只在这里收敛:vertical 与 preset 两种切换都复用同一条联动。 */
function selectPreset(current: SettingsDraft, presetId: string, row: CatalogPresetRow | undefined): SettingsDraft {
  const profiles = cataloguedProfiles(row),
    keepProfile = !row || profiles.length === 0 || profiles.some((profile) => profile.id === current.defaultProfile);
  return {
    ...current,
    defaultPreset: presetId,
    defaultProfile: keepProfile ? current.defaultProfile : (row.defaultProfile ?? current.defaultProfile),
  };
}

/** preset 行的 profile 取值面;清单为空时退到该 preset 的 defaultProfile,
 * 两者都没有(目录行不可解析)则交由并集逻辑只保留当前值。 */
function cataloguedProfiles(
  row:
    | {
        readonly profiles: ReadonlyArray<{ readonly id: string; readonly title: string }>;
        readonly defaultProfile: string | null;
      }
    | undefined,
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  if (!row) return [];
  if (row.profiles.length > 0) return row.profiles;
  return row.defaultProfile ? [{ id: row.defaultProfile, title: row.defaultProfile }] : [];
}
