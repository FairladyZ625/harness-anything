import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import type { EntityKindRow } from "../../entity-kind-catalog-client.ts";
import { entityKindQueryKeys } from "../../entity-kind-data.ts";
import {
  entityLocatorContentQuery,
  importEntity,
  receiptFailureText,
  repoDirectoryQuery,
} from "../../entity-locator-client.ts";
import {
  directoryHasReadme,
  titleOfDirectoryLocator,
  titleOfFileLocator,
  titleOfUrlLocator,
} from "../../entity-import-preview.ts";
import {
  emptyAttributeDraft,
  entityAttributeFields,
  readAttributeDraft,
  type EntityAttributeDraft,
} from "../../entity-attribute-form.ts";
import { EntityAttributeFields } from "./EntityAttributeFields.tsx";
import { RepoPathBrowser, commonParentDirectory } from "./RepoPathBrowser.tsx";
import { SegCtl } from "../primitives/SegCtl.tsx";

const LOCATOR_KINDS = ["repository-path", "url", "local-path", "external-key"] as const;
type LocatorKind = (typeof LOCATOR_KINDS)[number];

/** 来源只保存 locator 元数据；只有 snapshot 预览会读取已声明的仓内文件或 URL。 */
type SourceTarget =
  | { readonly kind: "repository-path"; readonly path: string; readonly directory: boolean }
  | { readonly kind: Exclude<LocatorKind, "repository-path">; readonly value: string };

/** 新实例会被钉到的那一版属性声明:版本号由中心铸,正文是这一版声明的属性表。 */
export interface PinnedAttributeSchema {
  readonly version: number;
  readonly attributes: unknown;
}

/**
 * 声明实体的新建向导(task_a494eac2 Goal 1):kind 已由所在页钉死 → 选定来源(浏览仓内
 * 文件/文件夹,或给一个外部 url)→ 显式选择 reference/snapshot → 按这个种类声明的属性填值 → 导入。
 * 人不再填 id/version/idPrefix/pathTemplate/descriptorSchemaRef——那些是 kind 声明的身份/
 * 存储字段,新建实体轮不到。
 *
 * 属性表单是**声明驱动**的:填什么由这个种类当前那一版属性声明说了算,GUI 里没有任何
 * 按 kind 写死的分支。reference 只登记 locator 且预览不读取来源正文;snapshot 才读取并
 * 接受来源字节作为实体内容。
 */
export function NewEntityWizard({
  repoId,
  row,
  seedRows,
  pinnedSchema,
  onCancel,
  onImported,
}: {
  readonly repoId: string;
  readonly row: EntityKindRow;
  /** 用来推导浏览器起点的既有行(同 kind 优先);空时浏览器退到 seed 输入。 */
  readonly seedRows: readonly { readonly locator: { readonly kind: string; readonly value: string } | null }[];
  /** 新实例会被钉到的那一版属性声明;这个种类还没有已发布版本时为 null。 */
  readonly pinnedSchema: PinnedAttributeSchema | null;
  readonly onCancel: () => void;
  readonly onImported: (entityRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const attributeFields = useMemo(() => entityAttributeFields(pinnedSchema?.attributes), [pinnedSchema]);
  const [attributeDraft, setAttributeDraft] = useState<EntityAttributeDraft>(() =>
    emptyAttributeDraft(attributeFields),
  );
  const attributeReading = readAttributeDraft(attributeFields, attributeDraft);
  const attributeIssues = Object.keys(attributeReading.issues).length;
  const locatorKinds = row.declaration?.locatorKinds ?? [];
  const acceptsPath = locatorKinds.includes("repository-path");
  const acceptsUrl = locatorKinds.includes("url");
  const snapshotLocatorKinds = LOCATOR_KINDS.filter(
    (kind) => (kind === "repository-path" || kind === "url") && locatorKinds.includes(kind),
  );
  const seed = useMemo(() => {
    const paths = seedRows
      .map(({ locator }) => (locator?.kind === "repository-path" ? locator.value : null))
      .filter((path): path is string => path !== null);
    return commonParentDirectory(paths);
  }, [seedRows]);
  const [sourceKind, setSourceKind] = useState<LocatorKind>(
    acceptsPath ? "repository-path" : acceptsUrl ? "url" : ((locatorKinds[0] as LocatorKind | undefined) ?? "url"),
  );
  const [mode, setMode] = useState<"reference" | "snapshot" | null>(null);
  // 起点输入分「草稿」与「已确认」两态:少了这一层,第一个字符一敲进去浏览器就把输入框
  // 顶掉,人永远输不完一个目录名。
  const [seedDraft, setSeedDraft] = useState("");
  const [browseRoot, setBrowseRoot] = useState<string | null>(null);
  const [locatorValues, setLocatorValues] = useState<Record<Exclude<LocatorKind, "repository-path">, string>>({
    url: "",
    "local-path": "",
    "external-key": "",
  });
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const [declaredContentVersion, setDeclaredContentVersion] = useState("");
  const [titleOverride, setTitleOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useDerivedPreview(repoId, row, target, mode);
  const snapshotUrlSupported = mode !== "snapshot" || target?.kind !== "url" || /^https?:\/\//iu.test(target.value);
  const availableLocatorKinds = mode === "reference" ? LOCATOR_KINDS : snapshotLocatorKinds;
  const importable =
    mode !== null && target !== null && preview !== null && attributeIssues === 0 && snapshotUrlSupported;
  const browseSeed = seed ?? browseRoot;

  const submit = () => {
    if (!importable || busy || mode === null || target === null) return;
    setBusy(true);
    setError(null);
    void importEntity({
      repoId,
      entityKind: row.kind,
      locator: target.kind === "repository-path" ? target.path : target.value,
      locatorKind: target.kind,
      mode,
      ...(mode === "reference" && declaredContentVersion.trim()
        ? { contentVersion: declaredContentVersion.trim() }
        : {}),
      ...(titleOverride.trim() ? { title: titleOverride.trim() } : {}),
      ...(Object.keys(attributeReading.values).length > 0 ? { attributes: attributeReading.values } : {}),
    })
      .then(async (receipt) => {
        if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") {
          setError(receiptFailureText(receipt));
          return;
        }
        await queryClient.invalidateQueries({ queryKey: entityKindQueryKeys.rows(repoId) });
        // The instance identity is minted by the center; the receipt is the only place it exists.
        const imported = importedEntityId(receipt);
        if (imported !== null) onImported(`${row.kind}/${imported}`);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const changeMode = (nextMode: "reference" | "snapshot" | null) => {
    setMode(nextMode);
    setTarget(null);
    const nextKinds = nextMode === "reference" ? LOCATOR_KINDS : snapshotLocatorKinds;
    if (!nextKinds.includes(sourceKind)) setSourceKind(nextKinds[0] ?? "url");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" data-testid="new-entity-wizard">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className="ui-body font-semibold">新建 {row.declaration?.display.singular ?? row.kind}</h2>
        <code className="break-all font-mono ui-micro text-text-faint">{row.kind}</code>
        <span className="ml-auto ui-micro text-text-faint">
          {mode === "reference"
            ? "只登记 locator，不读取内容；本机路径仅在登记节点可解析。"
            : mode === "snapshot"
              ? "读取并保存来源正文；之后来源移走或删除不影响实体内容。"
              : "请选择登记模式。"}
        </span>
      </header>

      <section className="flex flex-col gap-2" data-testid="new-entity-wizard-mode">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">登记模式</h3>
        <SegCtl
          label="登记模式"
          value={mode}
          onChange={changeMode}
          options={[
            {
              value: "reference",
              label: "引用",
              tip: "只登记 locator，不读取来源内容。",
              testId: "new-entity-wizard-mode-reference",
            },
            {
              value: "snapshot",
              label: "快照",
              tip: "读取来源并将观测到的字节保存到 Harness。",
              testId: "new-entity-wizard-mode-snapshot",
            },
          ]}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">选择来源</h3>
        {availableLocatorKinds.length > 1 && (
          <div className="flex gap-2" data-testid="new-entity-wizard-source-kind">
            {availableLocatorKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                data-testid={`new-entity-wizard-source-${kind}`}
                aria-pressed={sourceKind === kind}
                onClick={() => {
                  setSourceKind(kind);
                  setTarget(null);
                }}
                className={[
                  "rounded-md border px-2 py-1 ui-micro",
                  sourceKind === kind
                    ? "border-border-strong bg-surface-raised text-text"
                    : "border-border text-text-muted hover:text-text",
                ].join(" ")}
              >
                {locatorKindLabel(kind)}
              </button>
            ))}
          </div>
        )}
        {sourceKind !== "repository-path" ? (
          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {locatorInputLabel(sourceKind, mode)}
            <input
              data-testid={`new-entity-wizard-${sourceKind}`}
              aria-label={locatorInputLabel(sourceKind, mode)}
              value={locatorValues[sourceKind]}
              onChange={(event) => {
                const value = event.target.value,
                  trimmed = value.trim();
                setLocatorValues((previous) => ({ ...previous, [sourceKind]: value }));
                setTarget(validLocatorValue(sourceKind, trimmed) ? { kind: sourceKind, value: trimmed } : null);
              }}
              placeholder={locatorPlaceholder(sourceKind)}
              className="rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
            />
            {locatorValues[sourceKind] !== "" && !validLocatorValue(sourceKind, locatorValues[sourceKind].trim()) && (
              <span className="ui-micro text-status-blocked">{invalidLocatorMessage(sourceKind)}</span>
            )}
            {mode === "snapshot" && target?.kind === "url" && !snapshotUrlSupported && (
              <span className="ui-micro text-status-blocked">URL 快照只支持 http(s)；其他 scheme 请选引用模式。</span>
            )}
          </label>
        ) : browseSeed === null ? (
          <form
            data-testid="new-entity-wizard-seed"
            onSubmit={(event) => {
              event.preventDefault();
              if (validSeed(seedDraft)) setBrowseRoot(seedDraft.trim());
            }}
            className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
          >
            <p className="ui-meta text-text-faint">
              {"没有既有实体可以推断浏览起点;先给一个仓内目录(如 "}
              <code>harness/context</code>
              {"),再从那里浏览。"}
            </p>
            <div className="flex gap-2">
              <input
                aria-label="浏览起点目录"
                value={seedDraft}
                onChange={(event) => setSeedDraft(event.target.value)}
                placeholder="harness/context"
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
              />
              <button type="submit" data-testid="new-entity-wizard-seed-browse" disabled={!validSeed(seedDraft)}>
                浏览
              </button>
            </div>
            {seedDraft !== "" && !validSeed(seedDraft) && (
              <p className="ui-micro text-status-blocked">须为仓内相对目录路径:非空、不以 / 开头、不含 ..。</p>
            )}
          </form>
        ) : (
          <RepoPathBrowser
            repoId={repoId}
            seed={browseSeed}
            selectedPath={target?.kind === "repository-path" ? target.path : null}
            onPickDirectory={(path) => setTarget({ kind: "repository-path", path, directory: true })}
            onPickFile={(path) => setTarget({ kind: "repository-path", path, directory: false })}
          />
        )}
      </section>

      {attributeFields.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="new-entity-wizard-attributes">
          <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">
            属性
            {pinnedSchema !== null && (
              <span className="ml-2 font-mono normal-case text-text-faint">v{pinnedSchema.version}</span>
            )}
          </h3>
          <EntityAttributeFields
            fields={attributeFields}
            draft={attributeDraft}
            issues={attributeReading.issues}
            testIdPrefix="new-entity-attribute"
            onChange={(name, value) => setAttributeDraft((previous) => ({ ...previous, [name]: value }))}
          />
        </section>
      )}

      {mode === "reference" && (
        <label className="flex flex-col gap-1 ui-meta text-text-muted">
          调用方声明的内容版本(可留空;不会读取或校验来源)
          <input
            data-testid="new-entity-wizard-content-version"
            aria-label="调用方声明的内容版本"
            value={declaredContentVersion}
            onChange={(event) => setDeclaredContentVersion(event.target.value)}
            placeholder="revision-17 或 sha256:…"
            className="rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
          />
        </label>
      )}

      <section className="flex flex-col gap-2" data-testid="new-entity-wizard-preview-area">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">预览并导入</h3>
        {target === null ? (
          <p className="ui-meta text-text-faint">
            {sourceKind !== "repository-path"
              ? mode === "reference"
                ? `输入要登记的 ${locatorKindLabel(sourceKind)} locator；不需要可达。`
                : "输入已声明的 http(s) URL；快照会读取来源。"
              : "先在上面选定一个文件或文件夹。"}
          </p>
        ) : preview === null ? (
          <p className="ui-meta text-text-faint">正在推导预览…</p>
        ) : (
          <>
            <dl
              className={[
                "grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-1",
                "rounded-md border border-border bg-surface p-3",
              ].join(" ")}
            >
              <dt className="font-mono ui-micro text-text-faint">locator</dt>
              <dd data-testid="new-entity-wizard-locator" className="break-all font-mono ui-meta text-text">
                {target.kind === "repository-path" ? target.path : target.value}
              </dd>
              <dt className="font-mono ui-micro text-text-faint">title(推导)</dt>
              <dd className="break-all ui-meta text-text">{preview.title}</dd>
              <dt className="font-mono ui-micro text-text-faint">内容存放</dt>
              <dd className="break-all font-mono ui-micro text-text-muted">
                {row.declaration?.pathTemplate ?? "(kind 未声明 pathTemplate)"}
              </dd>
            </dl>
            <p className="ui-micro leading-relaxed text-text-faint">
              {mode === "reference"
                ? "标题仅按 locator 推导，不读取来源正文。"
                : "标题按来源推导；快照模式会读取正文。"}{" "}
              标题可以在下面改写。这个实体的编号在保存成功后给出。
            </p>
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              title 覆写(留空用推导值)
              <input
                data-testid="new-entity-wizard-title-override"
                aria-label="title 覆写"
                value={titleOverride}
                onChange={(event) => setTitleOverride(event.target.value)}
                placeholder={preview.title}
                className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
              />
            </label>
            {attributeIssues > 0 && (
              <p data-testid="new-entity-wizard-attributes-incomplete" className="ui-meta text-status-blocked">
                上面的属性还有 {attributeIssues} 项要补。
              </p>
            )}
            {error !== null && (
              <p data-testid="new-entity-wizard-error" className="ui-meta text-status-blocked">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="new-entity-wizard-submit"
                disabled={!importable || busy}
                onClick={submit}
                className={[
                  "rounded-md border border-border px-3 py-1.5 ui-meta text-text",
                  "hover:border-border-strong disabled:cursor-not-allowed disabled:text-text-faint",
                ].join(" ")}
              >
                {busy ? "导入中…" : "导入"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                className={[
                  "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1",
                  "ui-meta text-text-muted hover:text-text",
                ].join(" ")}
              >
                <ArrowLeft weight="bold" className="ui-micro" />
                取消
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** 预览:title 按 daemon 的派生规则(README 首标题/文件首标题/文件名/url 末段)。id 由中心铸,预览无从得知。 */
function useDerivedPreview(
  repoId: string,
  row: EntityKindRow,
  target: SourceTarget | null,
  mode: "reference" | "snapshot" | null,
): { readonly title: string } | null {
  const idPrefix = row.declaration?.idPrefix ?? null;
  const directoryTarget = target?.kind === "repository-path" && target.directory ? target.path : "";
  const fileTarget = target?.kind === "repository-path" && !target.directory ? target.path : "";
  const listing = useQuery({
    ...repoDirectoryQuery(repoId, directoryTarget),
    enabled: mode === "snapshot" && directoryTarget !== "",
  });
  const readmePath =
    directoryTarget !== "" && listing.data?.outcome === "directory" ? directoryHasReadme(listing.data.entries) : null;
  const readmeRead = useQuery({
    ...entityLocatorContentQuery(repoId, { kind: "repository-path", value: readmePath ?? "" }),
    enabled: mode === "snapshot" && readmePath !== null,
  });
  const fileRead = useQuery({
    ...entityLocatorContentQuery(repoId, { kind: "repository-path", value: fileTarget }),
    enabled: mode === "snapshot" && fileTarget !== "",
  });
  if (target === null || idPrefix === null || mode === null) return null;
  if (target.kind === "url") return { title: titleOfUrlLocator(target.value) };
  if (target.kind !== "repository-path")
    return { title: titleOfFileLocator("", target.value.replaceAll("\\", "/").split(":").at(-1) ?? target.value) };
  if (mode === "reference")
    return {
      title: target.directory
        ? (target.path.split("/").filter(Boolean).at(-1) ?? target.path)
        : titleOfFileLocator("", target.path),
    };
  if (target.directory) {
    if (listing.data === undefined || (readmePath !== null && readmeRead.data === undefined)) return null;
    const title = titleOfDirectoryLocator(
      readmeRead.data?.outcome === "file" ? (readmeRead.data.content ?? "") : null,
      target.path,
    );
    return { title };
  }
  if (fileRead.data === undefined) return null;
  const title =
    fileRead.data.outcome === "file"
      ? titleOfFileLocator(fileRead.data.content ?? "", target.path)
      : (target.path.split("/").at(-1) ?? target.path);
  return { title };
}

/** 回执顶层的实例身份:中心接受时铸的那一个,applied 与 replay(no_changes)回执都带。 */
function importedEntityId(receipt: unknown): string | null {
  if (typeof receipt !== "object" || receipt === null) return null;
  const entityId = (receipt as { readonly entityId?: unknown }).entityId;
  return typeof entityId === "string" ? entityId : null;
}

function validSeed(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && !trimmed.startsWith("/") && !trimmed.split("/").includes("..");
}

function validUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol !== "";
  } catch {
    return false;
  }
}

function validLocalPath(value: string): boolean {
  if (value.startsWith("file:")) {
    try {
      return new URL(value).protocol === "file:";
    } catch {
      return false;
    }
  }
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function validLocatorValue(kind: Exclude<LocatorKind, "repository-path">, value: string): boolean {
  if (!value) return false;
  if (kind === "url") return validUrl(value);
  if (kind === "local-path") return validLocalPath(value);
  return true;
}

function locatorKindLabel(kind: LocatorKind): string {
  return kind === "repository-path"
    ? "仓内文件或文件夹"
    : kind === "url"
      ? "外部 URL"
      : kind === "local-path"
        ? "本机路径"
        : "外部系统键";
}

function locatorInputLabel(kind: Exclude<LocatorKind, "repository-path">, mode: "reference" | "snapshot" | null) {
  return kind === "url"
    ? mode === "snapshot"
      ? "外部 URL(http(s) 快照会读取正文;引用可用任意 scheme)"
      : "外部 URL(引用只登记,不需要可达)"
    : kind === "local-path"
      ? "本机仓外路径(仅引用;只在登记节点定位)"
      : "外部系统键(仅引用;例如 provider:project:key)";
}

function locatorPlaceholder(kind: Exclude<LocatorKind, "repository-path">): string {
  return kind === "url"
    ? "https://example.com/issues/1 或 feishu://doc/123"
    : kind === "local-path"
      ? "/Users/name/KnowledgeBase/minutes.md"
      : "provider:project:key";
}

function invalidLocatorMessage(kind: Exclude<LocatorKind, "repository-path">): string {
  return kind === "url"
    ? "须是带 scheme 的绝对 URL。"
    : kind === "local-path"
      ? "须是绝对本机路径或 file URL。"
      : "外部系统键不能为空。";
}
