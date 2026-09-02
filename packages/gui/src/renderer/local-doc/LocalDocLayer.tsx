import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, X } from "@phosphor-icons/react";
import { DocReader } from "../components/DocReader.tsx";
import { t } from "../i18n/index.tsx";
import { requestLocalDocument } from "./local-doc-client.ts";
import { LocalDocContext, type LocalDocOpener } from "./local-doc-context.ts";

/**
 * 本机文档浮层(task_89d324b5):详情页 Markdown 里的项目外本机文件链接在 GUI 内
 * 打开阅读的唯一宿主。挂在 App 根部(LocalDocContext.Provider + 一次浮层),Markdown
 * 锚点经 context 交路径过来;读取走只读桥,失败按 typed code 出页内错误态 —— 不白屏、
 * 不弹系统对话框。Markdown 文件复用 DocReader(同一渲染面、同一阅读工具条),其它
 * 文本按纯文本呈现。
 */
export function LocalDocLayer({ children }: { readonly children: ReactNode }) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const openLocalDocument = useCallback((path: string) => setActivePath(path), []);
  const value = useMemo<LocalDocOpener>(() => ({ openLocalDocument }), [openLocalDocument]);
  return (
    <LocalDocContext.Provider value={value}>
      {children}
      {activePath !== null && <LocalDocOverlay path={activePath} onClose={() => setActivePath(null)} />}
    </LocalDocContext.Provider>
  );
}

function LocalDocOverlay({ path, onClose }: { readonly path: string; readonly onClose: () => void }) {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const query = useQuery({
    queryKey: ["local-doc", path],
    queryFn: () => requestLocalDocument(path),
    retry: false,
    staleTime: 5_000,
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 sm:p-8"
      data-testid="local-doc-overlay"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("components.localDoc.title")}
        className={
          "flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border-strong " +
          "bg-bg shadow-2xl"
        }
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <FileText weight="duotone" className="shrink-0 text-text-muted" />
          <span className="shrink-0 font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
            {t("components.localDoc.title")}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono ui-micro text-text-muted"
            data-testid="local-doc-path"
            title={path}
          >
            {query.data?.ok === true ? query.data.path : path}
          </span>
          {query.data?.ok === true && (
            <span className="shrink-0 font-mono ui-micro text-text-faint">
              {t("components.localDoc.sizeBytes", { count: query.data.sizeBytes })}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("components.localDoc.close")}
            data-testid="local-doc-close"
            className={
              "grid size-6 shrink-0 place-items-center rounded text-text-faint " +
              "hover:bg-surface-raised hover:text-text"
            }
          >
            <X weight="bold" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {query.isPending ? (
            <p data-testid="local-doc-loading" className="font-mono ui-meta text-text-faint">
              {t("components.localDoc.loading")}
            </p>
          ) : query.data === undefined || !query.data.ok ? (
            // 读取永不抛错(客户端把一切失败折叠成 typed 结果),这里只剩 typed 错误态;
            // data 意外缺席时同样按错误面兜住,不把空白/异常留给用户。
            query.data === undefined ? (
              <LocalDocError
                result={{ ok: false, code: "bridge_unavailable", path, message: "Local document read did not settle." }}
              />
            ) : (
              <LocalDocError result={query.data} />
            )
          ) : isMarkdownPath(path) ? (
            <DocReader content={query.data.content} />
          ) : (
            <pre
              data-testid="local-doc-plain"
              className={
                "whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-4 " +
                "font-mono ui-meta leading-5 text-text"
              }
            >
              {query.data.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function LocalDocError({
  result,
}: {
  readonly result: { readonly ok: false; readonly code: string; readonly path: string; readonly message: string };
}) {
  const message =
    result.code === "not_found"
      ? t("components.localDoc.errorNotFound", { path: result.path })
      : result.code === "not_a_regular_file"
        ? t("components.localDoc.errorNotARegularFile", { path: result.path })
        : result.code === "not_readable"
          ? t("components.localDoc.errorNotReadable", { path: result.path })
          : result.code === "binary_file"
            ? t("components.localDoc.errorBinaryFile", { path: result.path })
            : result.code === "too_large"
              ? t("components.localDoc.errorTooLarge", { path: result.path })
              : result.code === "bridge_unavailable"
                ? t("components.localDoc.errorBridgeUnavailable")
                : t("components.localDoc.errorRequestRejected", { message: result.message });
  return (
    <div
      data-testid={`local-doc-error-${result.code}`}
      className="rounded-md border border-danger/40 bg-danger/5 px-4 py-3"
    >
      <p className="ui-meta font-medium text-danger">{message}</p>
      <p className="mt-1 break-all font-mono ui-micro text-text-faint">{result.path}</p>
    </div>
  );
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}
