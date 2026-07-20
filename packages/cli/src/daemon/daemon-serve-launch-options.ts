import path from "node:path";

export function daemonRuntimeLayoutOverrides(
  rootDir: string,
  authoredRoot: string | undefined
): { readonly authoredRoot: string } | undefined {
  return authoredRoot === undefined ? undefined : {
    authoredRoot: path.relative(path.resolve(rootDir), authoredRoot) || "."
  };
}
