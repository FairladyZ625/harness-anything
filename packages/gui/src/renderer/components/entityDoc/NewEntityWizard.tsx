import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import type { EntityKindRow } from "../../entity-kind-catalog-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { entityKindQueryKeys } from "../../entity-kind-data.ts";
import {
  entityLocatorContentQuery,
  importEntity,
  receiptFailureText,
  repoDirectoryQuery,
} from "../../entity-locator-client.ts";
import { directoryHasReadme, titleOfDirectoryLocator, titleOfFileLocator } from "../../entity-import-preview.ts";
import { RepoPathBrowser, commonParentDirectory } from "./RepoPathBrowser.tsx";

/**
 * import 动作合同里不出现在向导里的字段(与旧 NewGovernedEntityForm 同一份理由):
 * entityKind 由所在页钉死;expectedVersion 新建恒为 0;entityId/sourceIdentity 是
 * relink 语义;idempotencyKey/dryRun 是通道参数。合同若出现别的字段,向导如实列出
 * 并指向 CLI,不静默丢。
 */
const HIDDEN_FIELDS = new Set([
  "entityKind",
  "expectedVersion",
  "entityId",
  "sourceIdentity",
  "idempotencyKey",
  "dryRun",
]);

export function importActionFields(row: EntityKindRow): readonly { field: string; required: boolean }[] {
  const action = row.explanation.transitions.actions.find(({ id }) => id === "import");
  return (action?.input?.fields ?? [])
    .filter(({ field }) => !HIDDEN_FIELDS.has(field))
    .map(({ field, required }) => ({ field, required }));
}

/**
 * 声明实体的新建向导(task_a494eac2 Goal 1):kind 已由所在页钉死 → 浏览选定仓内
 * 文件或文件夹 → 预览推导出的 title / id → 一键导入。人不再填 id/version/idPrefix/
 * pathTemplate/descriptorSchemaRef——那些是 kind 声明的身份/存储字段,新建实体轮不到。
 *
 * 写路还是 `repo.entity.import` 那条 center 单写路;预览在渲染层推导(公式见
 * entity-import-preview.ts),导入后以台账回执为准。
 */
export function NewEntityWizard({
  repoId,
  row,
  seedRows,
  onCancel,
  onImported,
}: {
  readonly repoId: string;
  readonly row: EntityKindRow;
  /** 用来推导浏览器起点的既有行(同 kind 优先);空时浏览器退到 seed 输入。 */
  readonly seedRows: readonly { readonly locator: { readonly kind: string; readonly value: string } | null }[];
  readonly onCancel: () => void;
  readonly onImported: (entityRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const unsupportedFields = useMemo(
    () => importActionFields(row).filter(({ field }) => field !== "locator" && field !== "title"),
    [row],
  );
  const seed = useMemo(() => {
    const paths = seedRows
      .map(({ locator }) => (locator?.kind === "repository-path" ? locator.value : null))
      .filter((path): path is string => path !== null);
    return commonParentDirectory(paths);
  }, [seedRows]);
  const [manualSeed, setManualSeed] = useState("");
  const [target, setTarget] = useState<{ readonly path: string; readonly directory: boolean } | null>(null);
  const [titleOverride, setTitleOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useDerivedPreview(repoId, row, target);
  const importable = target !== null && preview !== null;

  const submit = () => {
    if (!importable || busy) return;
    setBusy(true);
    setError(null);
    void importEntity({
      repoId,
      entityKind: row.kind,
      locator: target!.path,
      ...(titleOverride.trim() ? { title: titleOverride.trim() } : {}),
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
        <span className="ml-auto ui-micro text-text-faint">账本只记描述符,正文留在 locator 指向的地方。</span>
      </header>

      <section className="flex flex-col gap-2">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">1 · 选择正文位置(仓内路径)</h3>
        {unsupportedFields.map(({ field }) => (
          <p key={field} data-testid={`new-entity-wizard-unsupported-${field}`} className="ui-micro text-text-faint">
            合同字段 {field} 在这一页没有输入控件,请用 CLI `ha entity import` 提交。
          </p>
        ))}
        {seed === null && manualSeed === "" ? (
          <form
            data-testid="new-entity-wizard-seed"
            onSubmit={(event) => {
              event.preventDefault();
              if (validSeed(manualSeed)) setManualSeed(manualSeed.trim());
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
                value={manualSeed}
                onChange={(event) => setManualSeed(event.target.value)}
                placeholder="harness/context"
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
              />
              <button type="submit" disabled={!validSeed(manualSeed)}>
                浏览
              </button>
            </div>
            {manualSeed !== "" && !validSeed(manualSeed) && (
              <p className="ui-micro text-status-blocked">须为仓内相对目录路径:非空、不以 / 开头、不含 ..。</p>
            )}
          </form>
        ) : (
          <RepoPathBrowser
            repoId={repoId}
            seed={seed ?? manualSeed}
            selectedPath={target?.path ?? null}
            onPickDirectory={(path) => setTarget({ path, directory: true })}
            onPickFile={(path) => setTarget({ path, directory: false })}
          />
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="new-entity-wizard-preview-area">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">2 · 预览并导入</h3>
        {target === null ? (
          <p className="ui-meta text-text-faint">先在上面选定一个文件或文件夹;title 与 id 会自动推导。</p>
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
              <dd className="break-all font-mono ui-meta text-text">{target.path}</dd>
              <dt className="font-mono ui-micro text-text-faint">title(推导)</dt>
              <dd className="break-all ui-meta text-text">{preview.title}</dd>
              <dt className="font-mono ui-micro text-text-faint">存放</dt>
              <dd className="break-all font-mono ui-micro text-text-muted">
                {row.declaration?.pathTemplate ?? "(kind 未声明 pathTemplate)"}
              </dd>
            </dl>
            <p className="ui-micro leading-relaxed text-text-faint">
              {"预览按导入的派生规则在本地推导;导入走 center 单写路,落库的 id/title 以台账回执为准。"}
            </p>
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              title 覆写(留空用推导值)
              <input
                data-testid="new-entity-wizard-title-override"
                value={titleOverride}
                onChange={(event) => setTitleOverride(event.target.value)}
                placeholder={preview.title}
                className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
              />
            </label>
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

/** 预览:title 按 daemon 的派生规则(README 首标题/文件首标题/文件名)。id 由中心铸,预览无从得知。 */
function useDerivedPreview(
  repoId: string,
  row: EntityKindRow,
  target: { readonly path: string; readonly directory: boolean } | null,
): { readonly title: string } | null {
  const idPrefix = row.declaration?.idPrefix ?? null;
  const listing = useQuery({
    ...repoDirectoryQuery(repoId, target?.directory ? target.path : ""),
    enabled: target !== null && target.directory,
  });
  const readmePath =
    target !== null && target.directory && listing.data?.outcome === "directory"
      ? directoryHasReadme(listing.data.entries)
      : null;
  const readmeRead = useQuery({
    ...entityLocatorContentQuery(repoId, { kind: "repository-path", value: readmePath ?? "" }),
    enabled: readmePath !== null,
  });
  const fileRead = useQuery({
    ...entityLocatorContentQuery(repoId, {
      kind: "repository-path",
      value: target === null || target.directory ? "" : target.path,
    }),
    enabled: target !== null && !target.directory,
  });
  if (target === null || idPrefix === null) return null;
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

/** 回执里的实例身份:`entity import` 的 evidence 带着中心接受时铸的那一个。 */
function importedEntityId(receipt: unknown): string | null {
  if (typeof receipt !== "object" || receipt === null || !("evidence" in receipt)) return null;
  const evidence = (receipt as { readonly evidence?: unknown }).evidence;
  if (typeof evidence !== "string") return null;
  try {
    const parsed = JSON.parse(evidence) as { readonly preview?: { readonly entityId?: unknown } };
    return typeof parsed.preview?.entityId === "string" ? parsed.preview.entityId : null;
  } catch (cause) {
    // 回执不是本轮认识的形状:不导航,也不假装导入失败——导入的成败由 outcome 说了算。
    consumeKnownError(cause);
    return null;
  }
}

function validSeed(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && !trimmed.startsWith("/") && !trimmed.split("/").includes("..");
}
