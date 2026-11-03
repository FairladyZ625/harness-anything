// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { todoSoftLimitAdvisory } from "../../src/index.ts";
import { DEFAULT_TODO_SOFT_LIMIT, TODO_SOFT_LIMIT_SETTING } from "../../src/domain/todo-soft-limit.ts";

test("the todo soft limit defaults to 30 and is advisory only", () => {
  assert.equal(DEFAULT_TODO_SOFT_LIMIT, 30);
  assert.equal(TODO_SOFT_LIMIT_SETTING, "settings.todos.softLimit");
  assert.equal(todoSoftLimitAdvisory(3, DEFAULT_TODO_SOFT_LIMIT), null);
  assert.equal(todoSoftLimitAdvisory(DEFAULT_TODO_SOFT_LIMIT, DEFAULT_TODO_SOFT_LIMIT), null);
});

test("the advisory names the count, the limit and the cleanup route", () => {
  const advisory = todoSoftLimitAdvisory(31, DEFAULT_TODO_SOFT_LIMIT);
  assert.ok(advisory);
  assert.match(advisory, /31 unfinished todos exceed the soft limit of 30/u);
  assert.match(advisory, /settings\.todos\.softLimit/u);
  assert.match(advisory, /ha todo list/u);
  assert.match(advisory, /ha todo done <todo-id>/u);
  assert.match(advisory, /ha task create/u);
});

test("a soft limit of 0 turns the reminder off", () => {
  assert.equal(todoSoftLimitAdvisory(500, 0), null);
});
