import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PencilSimple, Archive, Trash } from "@phosphor-icons/react";
import type { GovernedEntityRow } from "../../graph/governedEntities.ts";
import { entityKindQueryKeys } from "../../entity-kind-data.ts";
import {
  archiveEntity,
  deleteEntity,
  entityWriteSettlement,
  updateEntity,
  type EntityWriteSettlement,
} from "../../entity-locator-client.ts";
import {
  attributeDraftFrom,
  divergedFields,
  entityAttributeFields,
  readAttributeDraft,
  type EntityAttributeDraft,
} from "../../entity-attribute-form.ts";
import { EntityAttributeFields } from "./EntityAttributeFields.tsx";
import type { PinnedAttributeSchema } from "./NewEntityWizard.tsx";

/**
 * 实体详情的操作区(task_a494eac2 Goal 4):编辑/归档/删除放在**详情**里,不再挤在列表行内。
 * 列表行只负责「是什么、去哪看」;改东西的动作聚到被选中实体的详情头部,与被操作
 * 对象同屏,避免 33 条实体每条都挂一排小按钮。
 *
 * 写路是 `repo.entity.update` / `repo.entity.archive` / `repo.entity.delete` 三条 center 单写路。
 * 每条都带 fence(这一行现在的 revision),冲突由 center 回报,这里如实展示、不重试。
 *
 * 编辑面有 title、locator 与**这个实例钉住的那一版**属性;contentVersion 不在这里——它是中心
 * 按接受的字节导出的内容摘要,不接受手填。属性表单按行读面给出的 `descriptor` 长出来:
 * 版本号是它当初钉的那一版,初值是它现在填的那些值,GUI 不替它猜一版,也不把已有的值抹掉。
 *
 * fence 不成立时(别人在你读到它之后改过它),表单**留在原地**:草稿一格不动,重读回来的
 * 那一行逐格摆在旁边,覆盖与重填都由人自己按一次。没提交的输入不因为别人的一次写而消失,
 * 也不在人没看见改了什么的情况下盖回去。
 */
export function EntityDetailActions({
  repoId,
  entity,
  pinnedSchema,
}: {
  readonly repoId: string;
  readonly entity: GovernedEntityRow;
  /** 这一条钉住的那一版属性声明;读不到那一版(或这一行不是描述符)时为 null。 */
  readonly pinnedSchema: PinnedAttributeSchema | null;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"edit" | "archive" | "delete" | null>(null);
  const [title, setTitle] = useState(entity.title ?? "");
  const [locator, setLocator] = useState(entity.locator?.value ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<EntityWriteSettlement | null>(null);
  const attributeFields = useMemo(() => entityAttributeFields(pinnedSchema?.attributes), [pinnedSchema]);
  const [attributeDraft, setAttributeDraft] = useState<EntityAttributeDraft>({});
  const attributeReading = readAttributeDraft(attributeFields, attributeDraft);
  const attributeIssues = Object.keys(attributeReading.issues).length;
  const locatorLabel = `${entity.locator?.kind ?? "locator"} locator`;
  /**
   * 中心此刻那一行的值。冲突之后行读面已经失效重读,所以这里读到的就是「现在」——
   * 与草稿逐格对出来的差,是别人这一次真的改了什么。
   */
  const heldValues: Readonly<Record<string, string>> = {
    title: entity.title ?? "",
    [locatorLabel]: entity.locator?.value ?? "",
    ...attributeDraftFrom(attributeFields, entity.descriptor?.attributes ?? {}),
  };
  const draftValues: Readonly<Record<string, string>> = { title, [locatorLabel]: locator, ...attributeDraft };
  const conflicted = mode === "edit" && settlement?.state === "conflict";
  const diverged = conflicted ? divergedFields(draftValues, heldValues) : [];
  /** 用中心现在的值重填这张表:覆盖草稿是人按下去的一个动作,不是界面替他做的。 */
  const adoptHeld = () => {
    setTitle(heldValues.title ?? "");
    setLocator(heldValues[locatorLabel] ?? "");
    setAttributeDraft(attributeDraftFrom(attributeFields, entity.descriptor?.attributes ?? {}));
    setSettlement(null);
  };
  /**
   * 每次打开编辑面都从**账本此刻的那一行**重新起草。保留上一次的草稿会让人看到自己刚才
   * 输入的内容而不是被接受的内容,写没写进去也就分不出来了。
   */
  const openEdit = () => {
    setTitle(entity.title ?? "");
    setLocator(entity.locator?.value ?? "");
    setAttributeDraft(attributeDraftFrom(attributeFields, entity.descriptor?.attributes ?? {}));
    setError(null);
    setSettlement(null);
    setMode("edit");
  };
  const finish = (receipt: { readonly outcome: string; readonly [key: string]: unknown }) => {
    const settled = entityWriteSettlement(receipt);
    setSettlement(settled);
    // 落定态本身就是一句话(`entity-detail-action-<state>`);再往 error 里抄一份,同一件事
    // 会在同一屏上说两遍。`error` 只留给根本没拿到回执的那一类失败。
    //
    // **只有被确认落定的那一次写才收表**。冲突是别人先写成功了,pending 是这次写有没有落定
    // 还说不出来——两种情况下人手上的东西都还没有着落,把表关掉就是替他把没写成的稿子丢了。
    if (settled.state !== "applied") {
      // 重读:界面上的 fence 必须换成中心现在那一条,人才改得下去。表单不关,草稿不动。
      if (settled.state === "conflict" || settled.state === "pending")
        void queryClient.invalidateQueries({ queryKey: entityKindQueryKeys.rows(repoId) });
      return;
    }
    setMode(null);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: entityKindQueryKeys.rows(repoId) });
  };
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  /** 归档与删除各要一个理由,而且是不同的一件事:换一个动作就换一张空的理由框。 */
  const openReasoned = (next: "archive" | "delete") => {
    setReason("");
    setError(null);
    // 上一个动作的回执说的是上一个动作;换一件事做就不该还挂在屏幕上。
    setSettlement(null);
    setMode(mode === next ? null : next);
  };
  if (entity.archived)
    return (
      <p
        data-testid="entity-detail-actions-archived"
        className="border-b border-border px-3 py-1.5 ui-micro text-text-faint"
      >
        已归档实体只读:描述符与它收管的文件都还在,需要复活时走 CLI relink 语义。删除是另一件事,
        那会把它收管的文件一起退役。
      </p>
    );
  return (
    <div className="border-b border-border px-3 py-2" data-testid="entity-detail-actions">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="entity-detail-edit"
          onClick={() => (mode === "edit" ? setMode(null) : openEdit())}
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1",
            "ui-micro text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <PencilSimple weight="bold" className="ui-micro" />
          编辑
        </button>
        <button
          type="button"
          data-testid="entity-detail-archive"
          onClick={() => openReasoned("archive")}
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1",
            "ui-micro text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <Archive weight="bold" className="ui-micro" />
          归档
        </button>
        <button
          type="button"
          data-testid="entity-detail-delete"
          onClick={() => openReasoned("delete")}
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1",
            "ui-micro text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <Trash weight="bold" className="ui-micro" />
          删除
        </button>
        {mode === null && <span className="ui-micro text-text-faint">这三个动作作用于当前选中的实体。</span>}
      </div>
      {mode === "edit" && (
        <form
          data-testid="entity-detail-edit-form"
          className="mt-2 flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (attributeIssues > 0) return;
            setError(null);
            setSettlement(null);
            void updateEntity({
              repoId,
              entityKind: entity.kind,
              entityId: entity.entityId,
              expectedVersion: entity.revision,
              title,
              locator,
              ...(attributeFields.length > 0 ? { attributes: attributeReading.values } : {}),
            })
              .then(finish)
              .catch(fail);
          }}
        >
          <input aria-label="title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <input aria-label={locatorLabel} value={locator} onChange={(event) => setLocator(event.target.value)} />
          {attributeFields.length > 0 && (
            <section className="mt-1 flex flex-col gap-1" data-testid="entity-detail-attributes">
              <h4 className="ui-micro uppercase tracking-wide text-text-faint">
                属性
                {pinnedSchema !== null && <span className="ml-2 font-mono normal-case">v{pinnedSchema.version}</span>}
              </h4>
              <EntityAttributeFields
                fields={attributeFields}
                draft={attributeDraft}
                issues={attributeReading.issues}
                testIdPrefix="entity-detail-attribute"
                onChange={(name, value) => setAttributeDraft((previous) => ({ ...previous, [name]: value }))}
              />
            </section>
          )}
          {entity.locator?.kind === "repository-path" && <span>保存后右侧预览会刷新。</span>}
          {attributeIssues > 0 && (
            <p data-testid="entity-detail-attributes-incomplete" className="ui-micro text-status-blocked">
              上面的属性还有 {attributeIssues} 项要补。
            </p>
          )}
          {conflicted && (
            <section
              data-testid="entity-detail-conflict-incoming"
              className="mt-1 flex flex-col gap-1 rounded-md border border-status-blocked/40 px-2 py-1.5"
            >
              <p className="ui-micro text-text-muted">
                你还没提交的修改留在上面这张表里。中心现在是第 {entity.revision} 版:
              </p>
              {diverged.length === 0 ? (
                <p data-testid="entity-detail-conflict-same" className="ui-micro text-text-faint">
                  你填的这几格和中心现在的值一样,再保存一次就行。
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {diverged.map((field) => (
                    <li
                      key={field.name}
                      data-testid={`entity-detail-conflict-field-${field.name}`}
                      className="ui-micro text-text-muted"
                    >
                      <span className="font-mono">{field.name}</span>:中心「{field.held || "(空)"}」,你的「
                      {field.draft || "(空)"}」
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                data-testid="entity-detail-conflict-adopt"
                onClick={adoptHeld}
                className="self-start rounded-md border border-border px-2 py-1 ui-micro text-text-muted"
              >
                用中心现在的值重填
              </button>
            </section>
          )}
          <button type="submit" data-testid="entity-detail-edit-save" disabled={attributeIssues > 0}>
            保存
          </button>
        </form>
      )}
      {mode === "archive" && (
        <form
          data-testid="entity-detail-archive-form"
          className="mt-2 flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void archiveEntity({
              repoId,
              entityKind: entity.kind,
              entityId: entity.entityId,
              expectedVersion: entity.revision,
              reason,
            })
              .then(finish)
              .catch(fail);
          }}
        >
          <input
            aria-label="归档原因"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="归档原因"
          />
          <button type="submit" data-testid="entity-detail-archive-confirm">
            确认归档
          </button>
        </form>
      )}
      {mode === "delete" && (
        <form
          data-testid="entity-detail-delete-form"
          className="mt-2 flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void deleteEntity({
              repoId,
              entityKind: entity.kind,
              entityId: entity.entityId,
              expectedVersion: entity.revision,
              reason,
            })
              .then(finish)
              .catch(fail);
          }}
        >
          <p className="ui-micro leading-relaxed text-text-faint">
            这条记录和它收管的那份内容一起退役,归档不同——归档两者都留下。它的来源文件不归它所有, 不会被动到。
          </p>
          <input
            aria-label="删除原因"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="删除原因"
          />
          <button type="submit" data-testid="entity-detail-delete-confirm">
            确认删除
          </button>
        </form>
      )}
      {settlement !== null && settlement.state !== "applied" && (
        <p
          data-testid={`entity-detail-action-${settlement.state}`}
          className={settlement.state === "pending" ? "ui-micro text-status-active" : "ui-micro text-status-blocked"}
        >
          {settlement.text}
        </p>
      )}
      {settlement?.state === "applied" && mode === null && (
        <p data-testid="entity-detail-action-applied" className="ui-micro text-text-faint">
          {settlement.text}
        </p>
      )}
      {error && (
        <p data-testid="entity-detail-action-error" className="ui-micro text-status-blocked">
          {error}
        </p>
      )}
    </div>
  );
}
