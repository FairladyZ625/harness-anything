import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUUpLeft, Info, LinkSimple, Plus, RocketLaunch } from "@phosphor-icons/react";
import { todosClient, type TodoRow } from "../todos-client.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Notice } from "../components/primitives/Notice.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { SegCtl } from "../components/primitives/SegCtl.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { t } from "../i18n/index.tsx";

type TodoView = "open" | "completed" | "archived";

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
  const [view, setView] = useState<TodoView>("open"),
    [text, setText] = useState(""),
    [relate, setRelate] = useState(""),
    [showRelation, setShowRelation] = useState(false),
    [expanded, setExpanded] = useState<string | null>(focusedEntityRef?.split("/")[1] ?? null),
    [completing, setCompleting] = useState<string | null>(null),
    [undoTodo, setUndoTodo] = useState<TodoRow | null>(null),
    undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    input = useRef<HTMLInputElement>(null),
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
  const rows = (query.data ?? []).filter((todo) =>
    view === "open" ? todo.open : view === "completed" ? todo.completed && !todo.archived : todo.archived,
  );
  const error = query.error ?? mutation.error;

  useEffect(() => {
    if (!targetRef && !query.isPending && (query.data?.length ?? 0) === 0) input.current?.focus();
  }, [query.data?.length, query.isPending, targetRef]);
  useEffect(
    () => () => {
      if (undoTimer.current !== null) clearTimeout(undoTimer.current);
    },
    [],
  );

  function showUndo(todo: TodoRow) {
    if (undoTimer.current !== null) clearTimeout(undoTimer.current);
    setUndoTodo(todo);
    undoTimer.current = setTimeout(() => setUndoTodo(null), 5000);
  }

  function complete(todo: TodoRow) {
    setCompleting(todo.id);
    mutation.mutate(
      async () => {
        await todosClient.done(repoId, todo.id);
        setCompleting(null);
        showUndo(todo);
      },
      { onError: () => setCompleting(null) },
    );
  }

  function undoComplete() {
    if (!undoTodo) return;
    const todo = undoTodo;
    setUndoTodo(null);
    if (undoTimer.current !== null) clearTimeout(undoTimer.current);
    mutation.mutate(() => todosClient.reopen(repoId, todo.id));
  }

  return (
    <section
      data-testid={targetRef ? "attached-todos" : "todos-view"}
      className={`flex min-h-0 min-w-0 flex-col ${targetRef ? "bounded-content shrink-0 border-t border-border" : "flex-1"}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{t(targetRef ? "todos.attached" : "todos.title")}</h2>
        {!targetRef && (
          <SegCtl
            label={t("todos.views")}
            value={view}
            onChange={setView}
            options={[
              { value: "open", label: t("todos.openView"), testId: "todos-view-open" },
              { value: "completed", label: t("todos.completedView"), testId: "todos-view-completed" },
              { value: "archived", label: t("todos.archivedView"), testId: "todos-view-archived" },
            ]}
          />
        )}
      </header>
      {!targetRef && (
        <form
          className="flex items-center gap-2 border-b border-border px-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            mutation.mutate(async () => {
              await todosClient.add(repoId, text, relate.trim() || undefined);
              setText("");
              setRelate("");
              setShowRelation(false);
            });
          }}
        >
          <Plus size={18} className="shrink-0 text-text-faint" aria-hidden="true" />
          <input
            ref={input}
            aria-label={t("todos.text")}
            data-testid="todo-text"
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-text-faint focus-visible:ring-1 focus-visible:ring-accent"
            placeholder={t("todos.placeholder")}
            value={text}
            maxLength={2000}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            ariaLabel={t("todos.optionalRelation")}
            tip={t("todos.optionalRelation")}
            testId="todo-add-relation"
            variant="ghost"
            size="sm"
            onClick={() => setShowRelation((shown) => !shown)}
          >
            <LinkSimple size={16} aria-hidden="true" />
          </Button>
          <Button
            type="submit"
            ariaLabel={t("todos.add")}
            tip={t("todos.add")}
            variant="primary"
            size="sm"
            disabled={!text.trim() || mutation.isPending}
          >
            {t("todos.add")}
          </Button>
          {showRelation && (
            <input
              autoFocus
              aria-label={t("todos.optionalRelation")}
              data-testid="todo-relation-input"
              className="absolute mt-20 right-4 z-10 w-64 rounded border border-border bg-surface px-2 py-1.5 ui-meta shadow-sm"
              placeholder="task/…"
              value={relate}
              onChange={(event) => setRelate(event.target.value)}
            />
          )}
        </form>
      )}
      {error && <Notice tone="bad">{error.message}</Notice>}
      {undoTodo && (
        <div
          role="status"
          data-testid="todo-undo-toast"
          className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 ui-meta"
        >
          <span>{t("todos.doneToast", { text: undoTodo.text })}</span>
          <Button size="sm" variant="ghost" ariaLabel={t("todos.undo")} onClick={undoComplete}>
            {t("todos.undo")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-4">
        {query.isPending ? (
          <Empty>{t("todos.loading")}</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            {t(view === "open" ? "todos.empty" : view === "completed" ? "todos.emptyCompleted" : "todos.emptyArchived")}
          </Empty>
        ) : (
          rows.map((todo) => (
            <div
              key={todo.id}
              data-testid={`todo-${todo.id}`}
              data-completing={completing === todo.id || undefined}
              className="group flex min-h-10 flex-wrap items-center gap-2 border-b border-border/70 py-1.5 transition-colors duration-150 hover:bg-surface/70 focus-within:bg-surface/70 motion-reduce:transition-none"
            >
              <button
                type="button"
                aria-label={
                  todo.completed || todo.archived
                    ? t("todos.reopenTodo", { text: todo.text })
                    : t("todos.complete", { text: todo.text })
                }
                aria-pressed={todo.completed || completing === todo.id}
                data-testid={`todo-toggle-${todo.id}`}
                disabled={mutation.isPending}
                onClick={() =>
                  todo.completed || todo.archived
                    ? mutation.mutate(() => todosClient.reopen(repoId, todo.id))
                    : complete(todo)
                }
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs text-accent hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${todo.completed || completing === todo.id ? "bg-accent text-accent-fg" : "bg-transparent"}`}
              >
                {todo.completed || completing === todo.id ? (
                  "✓"
                ) : todo.archived ? (
                  <ArrowUUpLeft size={13} aria-hidden="true" />
                ) : (
                  ""
                )}
              </button>
              <div
                className={`min-w-0 flex-1 truncate text-sm ${todo.completed || completing === todo.id ? "text-text-faint line-through" : "text-text"}`}
              >
                {todo.text}
                {todo.relations.map((relation) => (
                  <EntityRefLink
                    key={relation.ref}
                    entityRef={relation.ref}
                    onNavigate={onNavigateEntity}
                    className="ml-2 inline-block max-w-48 truncate align-baseline text-xs text-text-muted hover:text-accent hover:underline"
                  >
                    {relation.title}
                  </EntityRefLink>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                <Button
                  size="sm"
                  variant="ghost"
                  ariaLabel={t("todos.details")}
                  tip={t("todos.details")}
                  testId={`todo-details-${todo.id}`}
                  onClick={() => setExpanded(expanded === todo.id ? null : todo.id)}
                >
                  <Info size={16} aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  ariaLabel={todo.archived ? t("todos.reopen") : t("todos.archive")}
                  tip={todo.archived ? t("todos.reopen") : t("todos.archive")}
                  testId={`todo-archive-${todo.id}`}
                  onClick={() =>
                    mutation.mutate(() =>
                      todo.archived ? todosClient.reopen(repoId, todo.id) : todosClient.archive(repoId, todo.id),
                    )
                  }
                >
                  {todo.archived ? (
                    <ArrowUUpLeft size={16} aria-hidden="true" />
                  ) : (
                    <Archive size={16} aria-hidden="true" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  ariaLabel={t("todos.promote")}
                  tip={t("todos.promote")}
                  testId={`todo-promote-${todo.id}`}
                  onClick={() => setExpanded(expanded === todo.id ? null : todo.id)}
                >
                  <RocketLaunch size={16} aria-hidden="true" />
                </Button>
              </div>
              {expanded === todo.id && (
                <TodoActions
                  repoId={repoId}
                  todo={todo}
                  onNavigateEntity={onNavigateEntity}
                  run={(run) => mutation.mutate(run)}
                  pending={mutation.isPending}
                />
              )}
            </div>
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
    <div className="basis-full border-l-2 border-accent/40 pl-3 py-2">
      {detail.error && <Notice tone="bad">{detail.error.message}</Notice>}
      <div className="mb-2 flex flex-wrap gap-2">
        {detail.data?.relations.map((edge) => (
          <EntityRefLink key={edge.relationId} entityRef={edge.targetRef} onNavigate={onNavigateEntity} />
        ))}
      </div>
      <form
        className="mb-2 flex flex-wrap gap-2"
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
