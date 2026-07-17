import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ROT-014 / F-L7-02: Task server-state must have a single owner.
 * TanStack Query (`useTasksQuery`) is the sole owner; App.tsx must not mirror
 * the projection into a second `const [tasks, setTasks] = useState(...)`.
 *
 * Detector mirrors architecture-rot-registry.json ROT-014 command.
 */
function countTaskServerStateOwners(appSource: string, fileName: string) {
  const source = ts.createSourceFile(
    fileName,
    appSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let queryOwner = false;
  let localTaskOwners = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "useTasksQuery"
    ) {
      queryOwner = true;
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isArrayBindingPattern(node.name)
      && node.name.elements[0]
      && ts.isBindingElement(node.name.elements[0])
      && ts.isIdentifier(node.name.elements[0].name)
      && node.name.elements[0].name.text === "tasks"
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === "useState"
    ) {
      localTaskOwners += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    queryOwner,
    localTaskOwners,
    totalServerStateOwners: (queryOwner ? 1 : 0) + localTaskOwners,
  };
}

describe("ROT-014 Task server-state single owner", () => {
  const appPath = path.resolve(import.meta.dirname, "../src/renderer/App.tsx");
  const appSource = readFileSync(appPath, "utf-8");

  it("keeps useTasksQuery as the sole Task server-state owner in App.tsx", () => {
    const owners = countTaskServerStateOwners(appSource, appPath);
    expect(owners).toEqual({
      queryOwner: true,
      localTaskOwners: 0,
      totalServerStateOwners: 1,
    });
  });

  it("does not reintroduce a tasks useState mirror or setTasks replay effect", () => {
    expect(appSource).not.toMatch(/const\s*\[\s*tasks\s*,\s*setTasks\s*\]\s*=\s*useState/);
    expect(appSource).not.toMatch(/setTasks\s*\(/);
  });
});
