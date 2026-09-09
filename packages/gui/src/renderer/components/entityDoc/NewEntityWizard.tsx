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
  type EntityAttributeField,
} from "../../entity-attribute-form.ts";
import { RepoPathBrowser, commonParentDirectory } from "./RepoPathBrowser.tsx";

/** 选中的来源:仓内路径(文件或目录)或外部 url。两种都只是一个 locator 字符串。 */
type SourceTarget =
  | { readonly kind: "repository-path"; readonly path: string; readonly directory: boolean }
  | { readonly kind: "url"; readonly url: string };

/** 新实例会被钉到的那一版属性声明:版本号由中心铸,正文是这一版声明的属性表。 */
export interface PinnedAttributeSchema {
  readonly version: number;
  readonly attributes: unknown;
}

/**
 * 声明实体的新建向导(task_a494eac2 Goal 1):kind 已由所在页钉死 → 选定来源(浏览仓内
 * 文件/文件夹,或给一个外部 url)→ 按这个种类声明的属性填值 → 预览推导出的 title → 导入。
 * 人不再填 id/version/idPrefix/pathTemplate/descriptorSchemaRef——那些是 kind 声明的身份/
 * 存储字段,新建实体轮不到。
 *
 * 属性表单是**声明驱动**的:填什么由这个种类当前那一版属性声明说了算,GUI 里没有任何
 * 按 kind 写死的分支。导入被接受时,来源的正文成为这个实体自己的内容,locator 只记录它
 * 当初来自哪里。
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
  const seed = useMemo(() => {
    const paths = seedRows
      .map(({ locator }) => (locator?.kind === "repository-path" ? locator.value : null))
      .filter((path): path is string => path !== null);
    return commonParentDirectory(paths);
  }, [seedRows]);
  const [sourceKind, setSourceKind] = useState<"repository-path" | "url">(acceptsPath ? "repository-path" : "url");
  // 起点输入分「草稿」与「已确认」两态:少了这一层,第一个字符一敲进去浏览器就把输入框
  // 顶掉,人永远输不完一个目录名。
  const [seedDraft, setSeedDraft] = useState("");
  const [browseRoot, setBrowseRoot] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const [titleOverride, setTitleOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useDerivedPreview(repoId, row, target);
  const importable = target !== null && preview !== null && attributeIssues === 0;
  const browseSeed = seed ?? browseRoot;

  const submit = () => {
    if (!importable || busy) return;
    setBusy(true);
    setError(null);
    void importEntity({
      repoId,
      entityKind: row.kind,
      locator: target.kind === "url" ? target.url : target.path,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" data-testid="new-entity-wizard">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className="ui-body font-semibold">新建 {row.declaration?.display.singular ?? row.kind}</h2>
        <code className="break-all font-mono ui-micro text-text-faint">{row.kind}</code>
        <span className="ml-auto ui-micro text-text-faint">
          导入后正文归这个实体所有;来源路径只作记录,之后移走或删掉都不影响阅读。
        </span>
      </header>

      <section className="flex flex-col gap-2">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">选择来源</h3>
        {acceptsPath && acceptsUrl && (
          <div className="flex gap-2" data-testid="new-entity-wizard-source-kind">
            {(["repository-path", "url"] as const).map((kind) => (
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
                {kind === "repository-path" ? "仓内文件或文件夹" : "外部 URL"}
              </button>
            ))}
          </div>
        )}
        {sourceKind === "url" ? (
          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            外部 URL(声明允许 url 指针;导入时 daemon 会真的取一次)
            <input
              data-testid="new-entity-wizard-url"
              aria-label="外部 URL"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setTarget(validUrl(event.target.value) ? { kind: "url", url: event.target.value.trim() } : null);
              }}
              placeholder="https://example.com/issues/1"
              className="rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
            />
            {url !== "" && !validUrl(url) && (
              <span className="ui-micro text-status-blocked">须是 http(s) 开头的绝对 URL。</span>
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
          {attributeFields.map((field) => (
            <AttributeInput
              key={field.name}
              field={field}
              value={attributeDraft[field.name] ?? ""}
              issue={attributeReading.issues[field.name] ?? null}
              onChange={(value) => setAttributeDraft((previous) => ({ ...previous, [field.name]: value }))}
            />
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2" data-testid="new-entity-wizard-preview-area">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">预览并导入</h3>
        {target === null ? (
          <p className="ui-meta text-text-faint">
            {sourceKind === "url"
              ? "先给一个可取的 URL;title 会自动推导。"
              : "先在上面选定一个文件或文件夹;title 会自动推导。"}
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
                {target.kind === "url" ? target.url : target.path}
              </dd>
              <dt className="font-mono ui-micro text-text-faint">title(推导)</dt>
              <dd className="break-all ui-meta text-text">{preview.title}</dd>
              <dt className="font-mono ui-micro text-text-faint">内容存放</dt>
              <dd className="break-all font-mono ui-micro text-text-muted">
                {row.declaration?.pathTemplate ?? "(kind 未声明 pathTemplate)"}
              </dd>
            </dl>
            <p className="ui-micro leading-relaxed text-text-faint">
              标题按来源推导,可以在下面改写。这个实体的编号在保存成功后给出。
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

/**
 * 一个声明属性的输入控件。控件形态只由**声明**决定:给了取值清单就是下拉,布尔是复选框,
 * 数字是数字框——没有任何按 kind 名字写死的分支,新声明一个种类不必回来改这里。
 */
function AttributeInput({
  field,
  value,
  issue,
  onChange,
}: {
  readonly field: EntityAttributeField;
  readonly value: string;
  readonly issue: string | null;
  readonly onChange: (value: string) => void;
}) {
  const label = (
    <span className="flex items-baseline gap-2">
      <span className="font-mono">{field.name}</span>
      <span className={field.required ? "ui-micro text-accent" : "ui-micro text-text-faint"}>
        {field.required ? "必填" : "可选"}
      </span>
    </span>
  );
  if (field.type === "boolean")
    return (
      <label
        className="flex items-center gap-2 ui-meta text-text-muted"
        data-testid={`new-entity-attribute-${field.name}`}
      >
        <input
          type="checkbox"
          aria-label={field.name}
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        {label}
      </label>
    );
  return (
    <label className="flex flex-col gap-1 ui-meta text-text-muted" data-testid={`new-entity-attribute-${field.name}`}>
      {label}
      {field.options !== null ? (
        <select
          aria-label={field.name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
        >
          <option value="">未选择</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={field.name}
          type={field.type === "string" ? "text" : "number"}
          {...(field.type === "integer" ? { step: 1 } : {})}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
        />
      )}
      {issue !== null && value.trim() !== "" && <span className="ui-micro text-status-blocked">{issue}</span>}
    </label>
  );
}

/** 预览:title 按 daemon 的派生规则(README 首标题/文件首标题/文件名/url 末段)。id 由中心铸,预览无从得知。 */
function useDerivedPreview(
  repoId: string,
  row: EntityKindRow,
  target: SourceTarget | null,
): { readonly title: string } | null {
  const idPrefix = row.declaration?.idPrefix ?? null;
  const directoryTarget = target?.kind === "repository-path" && target.directory ? target.path : "";
  const fileTarget = target?.kind === "repository-path" && !target.directory ? target.path : "";
  const listing = useQuery({
    ...repoDirectoryQuery(repoId, directoryTarget),
    enabled: directoryTarget !== "",
  });
  const readmePath =
    directoryTarget !== "" && listing.data?.outcome === "directory" ? directoryHasReadme(listing.data.entries) : null;
  const readmeRead = useQuery({
    ...entityLocatorContentQuery(repoId, { kind: "repository-path", value: readmePath ?? "" }),
    enabled: readmePath !== null,
  });
  const fileRead = useQuery({
    ...entityLocatorContentQuery(repoId, { kind: "repository-path", value: fileTarget }),
    enabled: fileTarget !== "",
  });
  if (target === null || idPrefix === null) return null;
  if (target.kind === "url") return { title: titleOfUrlLocator(target.url) };
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
  return /^https?:\/\/\S+$/iu.test(value.trim());
}
