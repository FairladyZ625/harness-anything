import type { ReactNode } from "react";
import { Empty } from "../../components/primitives/Empty.tsx";
import { Notice } from "../../components/primitives/Notice.tsx";
import { HtmlArtifactPreview } from "../../components/HtmlArtifactPreview.tsx";
import { TASK_EXPLAINER_DOC, useTaskDocumentListQuery, useTaskDocumentQuery } from "../../task-data.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 工作说明(living explainer)正文面:工作页页签与概况预览共用的一份渲染。
 * 清单/正文走根任务同一对 document 查询(缓存键含 repo+task+path),HTML 只经
 * HtmlArtifactPreview 的隔离渲染;缺失、加载、失败、投影未追平各自如实可见,
 * 不互相冒充。工作树未提交的正文优先并如实标注(与任务详情文件页同一取舍)。
 */

/** 状态面的机读判别(测试与可访问性用);正文就绪时不带 data-state。 */
type WorkExplainerState =
  | "repo-missing"
  | "list-pending"
  | "list-error"
  | "missing"
  | "body-pending"
  | "body-error"
  | "not-ready"
  | "not-materialized"
  | "binary";

export function WorkExplainerDocument({
  repoId,
  taskId,
  fill = false,
}: {
  readonly repoId: string;
  readonly taskId: string;
  /** 页签主正文=true:高度链 flex 到 webview;概况预览=false:嵌入卡形态。 */
  readonly fill?: boolean;
}) {
  const readable = repoId !== "unselected";
  const documentList = useTaskDocumentListQuery(repoId, readable ? taskId : null);
  const present =
    documentList.data?.status === "ready" &&
    documentList.data.documents.some(({ path }) => path === TASK_EXPLAINER_DOC);
  const document = useTaskDocumentQuery(repoId, taskId, present ? TASK_EXPLAINER_DOC : null);

  let state: WorkExplainerState | null = null;
  let statusLine: ReactNode = null;
  if (!readable) {
    state = "repo-missing";
    statusLine = <Empty>{t("views.workspace.explainer.repoMissing")}</Empty>;
  } else if (documentList.isPending) {
    state = "list-pending";
    statusLine = <Empty>{t("views.workspace.explainer.listPending")}</Empty>;
  } else if (documentList.isError) {
    state = "list-error";
    statusLine = (
      <Notice tone="bad">{t("views.workspace.explainer.listFailed", { message: documentList.error.message })}</Notice>
    );
  } else if (!present) {
    state = "missing";
    statusLine = <Empty>{t("views.workspace.explainer.missing")}</Empty>;
  } else if (document.isPending) {
    state = "body-pending";
    statusLine = <Empty>{t("views.workspace.explainer.bodyPending")}</Empty>;
  } else if (document.isError) {
    state = "body-error";
    statusLine = (
      <Notice tone="bad">{t("views.workspace.explainer.bodyFailed", { message: document.error.message })}</Notice>
    );
  } else if (document.data.status !== "ready") {
    state = "not-ready";
    statusLine = <Empty>{t("views.workspace.explainer.notReady")}</Empty>;
  } else if (document.data.contentKind === "binary") {
    state = "binary";
    statusLine = <Notice tone="bad">{t("views.workspace.explainer.binary")}</Notice>;
  } else {
    const body =
      document.data.uncommitted && document.data.worktreeBody !== null
        ? document.data.worktreeBody
        : document.data.body;
    if (body === null) {
      state = "not-materialized";
      statusLine = <Empty>{t("views.workspace.explainer.notMaterialized")}</Empty>;
    }
  }

  return (
    <section
      data-testid="work-explainer-document"
      {...(state === null ? {} : { "data-state": state })}
      className={fill ? "flex h-full min-h-0 min-w-0 flex-col" : ""}
    >
      {state !== null ? (
        statusLine
      ) : (
        <>
          {document.data!.uncommitted && document.data!.worktreeBody !== null && (
            <p
              data-testid="work-explainer-uncommitted"
              className={[
                "mb-2 shrink-0 border border-status-blocked/40 bg-status-blocked/10",
                "px-2.5 py-1.5 ui-micro text-status-blocked",
              ].join(" ")}
            >
              {t("views.workspace.explainer.uncommitted")}
            </p>
          )}
          <div className="min-h-0 flex-1">
            <HtmlArtifactPreview
              content={
                document.data!.uncommitted && document.data!.worktreeBody !== null
                  ? document.data!.worktreeBody!
                  : document.data!.body!
              }
              path={TASK_EXPLAINER_DOC}
              fillAvailable={fill}
            />
          </div>
        </>
      )}
    </section>
  );
}
