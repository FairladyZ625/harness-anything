import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { todosClient, type TodoRow } from "../todos-client.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Notice } from "../components/primitives/Notice.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { RecordRow } from "../components/primitives/RecordRow.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { t } from "../i18n/index.tsx";

export function TodosView({
  repoId,
  onNavigateEntity,
  focusedEntityRef = null,
  targetRef,
}: {
  readonly repoId: string;
  readonly onNavigateEntity: (ref: string) => void;
  readonly focusedEntityRef?: string | null;
  readonly targetRef?: string;
}) {
  const [historyChoice, setHistory] = useState<boolean | null>(null),
    [text, setText] = useState(""),
    [relate, setRelate] = useState(""),
    [expanded, setExpanded] = useState<string | null>(focusedEntityRef?.split("/")[1] ?? null),
    queryClient = useQueryClient(),
    query = useQuery({
      queryKey: ["todos", repoId, targetRef ?? null],
      queryFn: () => todosClient.list(repoId, targetRef),
    }),
    mutation = useMutation({
      mutationFn: (run: () => Promise<unknown>) => run(),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ["todos", repoId] });
        await queryClient.invalidateQueries({ queryKey: ["agenda", repoId] });
      },
    });
  const focused = query.data?.find((row) => row.ref === focusedEntityRef),
    history = historyChoice ?? (focused ? !focused.open : false);
  const rows = (query.data ?? []).filter((row) => (history ? !row.open : row.open));
  const error = query.error ?? mutation.error;
  return (
    <section
      data-testid={targetRef ? "attached-todos" : "todos-view"}
      className={`flex min-h-0 min-w-0 flex-col ${targetRef ? "bounded-content shrink-0 border-t border-border" : "flex-1"}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{t(targetRef ? "todos.attached" : "todos.title")}</h2>
        <Button size="sm" onClick={() => setHistory(!history)}>
          {t(history ? "todos.backOpen" : "todos.history")}
        </Button>
      </header>
      {!targetRef && (
        <form
          className="flex flex-wrap items-center gap-2 border-b border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(async () => {
              await todosClient.add(repoId, text, relate.trim() || undefined);
              setText("");
              setRelate("");
            });
          }}
        >
          <input
            aria-label={t("todos.text")}
            data-testid="todo-text"
            className="min-w-48 flex-1 rounded border border-border bg-surface px-3 py-2"
            placeholder={t("todos.placeholder")}
            value={text}
            maxLength={2000}
            required
            onChange={(event) => setText(event.target.value)}
          />
          <input
            aria-label={t("todos.optionalRelation")}
            className="min-w-40 rounded border border-border bg-surface px-3 py-2"
            placeholder={t("todos.optionalRelation")}
            value={relate}
            onChange={(event) => setRelate(event.target.value)}
          />
          <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!text.trim()}>
            {t("todos.add")}
          </Button>
        </form>
      )}
      {error && <Notice tone="bad">{error.message}</Notice>}
      <div className="min-h-0 flex-1 overflow-auto px-4">
        {query.isPending ? (
          <Empty>{t("todos.loading")}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t(history ? "todos.emptyHistory" : "todos.empty")}</Empty>
        ) : (
          rows.map((todo) => (
            <RecordRow
              key={todo.id}
              testId={`todo-${todo.id}`}
              focused={expanded === todo.id}
              id={
                <div className="flex min-w-0 items-center gap-2">
                  {!history && (
                    <input
                      type="checkbox"
                      aria-label={t("todos.complete", { text: todo.text })}
                      checked={false}
                      disabled={mutation.isPending}
                      onChange={() => {
                        setHistory(false);
                        mutation.mutate(() => todosClient.done(repoId, todo.id));
                      }}
                    />
                  )}
                  <EntityRefLink
                    entityRef={`todo/${todo.id}`}
                    onNavigate={() => setExpanded(expanded === todo.id ? null : todo.id)}
                  />
                </div>
              }
              state={history ? t(todo.archived ? "todos.archived" : "todos.completed") : undefined}
              action={
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setExpanded(expanded === todo.id ? null : todo.id)}>
                    {t("todos.details")}
                  </Button>
                  {history ? (
                    <Button
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate(() => todosClient.reopen(repoId, todo.id))}
                    >
                      {t("todos.reopen")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate(() => todosClient.archive(repoId, todo.id))}
                    >
                      {t("todos.archive")}
                    </Button>
                  )}
                </div>
              }
              summary={
                <>
                  <p>{todo.text}</p>
                  {expanded === todo.id && (
                    <TodoActions
                      repoId={repoId}
                      todo={todo}
                      onNavigateEntity={onNavigateEntity}
                      run={(run) => mutation.mutate(run)}
                      pending={mutation.isPending}
                    />
                  )}
                </>
              }
            />
          ))
        )}
      </div>
    </section>
  );
}

function TodoActions({
  repoId,
  todo,
  onNavigateEntity,
  run,
  pending,
}: {
  readonly repoId: string;
  readonly todo: TodoRow;
  readonly onNavigateEntity: (ref: string) => void;
  readonly run: (action: () => Promise<unknown>) => void;
  readonly pending: boolean;
}) {
  const [target, setTarget] = useState(""),
    [work, setWork] = useState(""),
    detail = useQuery({
      queryKey: ["todos", repoId, "detail", todo.id],
      queryFn: () => todosClient.show(repoId, todo.id),
    });
  return (
    <div className="mt-3 flex flex-col gap-3">
      {detail.error && <Notice tone="bad">{detail.error.message}</Notice>}
      <div className="flex flex-wrap gap-2">
        {detail.data?.relations.length === 0 && <Empty>{t("todos.noRelations")}</Empty>}
        {detail.data?.relations.map((edge) => (
          <EntityRefLink key={edge.relationId} entityRef={edge.targetRef} onNavigate={onNavigateEntity} />
        ))}
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await todosClient.relate(repoId, todo.id, target.trim());
            setTarget("");
          });
        }}
      >
        <input
          aria-label={t("todos.relationTarget")}
          className="min-w-0 rounded border border-border bg-surface px-2 py-1"
          placeholder="task/…"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={pending || !target.trim()}>
          {t("todos.relate")}
        </Button>
      </form>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => todosClient.promote(repoId, todo.id, work.trim()));
        }}
      >
        <input
          aria-label={t("todos.work")}
          className="min-w-0 rounded border border-border bg-surface px-2 py-1"
          placeholder={t("todos.work")}
          value={work}
          onChange={(event) => setWork(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={pending || !work.trim()}>
          {t("todos.promote")}
        </Button>
      </form>
    </div>
  );
}
