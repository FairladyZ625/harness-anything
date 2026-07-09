export interface ReadScalarOptions {
  readonly required?: boolean;
}

export function readFrontmatter(body: string): string | null {
  return body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? null;
}

export function readScalar(frontmatter: string, key: string, options: ReadScalarOptions = {}): string {
  const value = matchScalar(frontmatter, key, "");
  if (value === undefined) {
    if (options.required) throw new Error(`frontmatter missing ${key.trim()}`);
    return "";
  }
  return value.trim();
}

export function readNestedScalar(block: string, key: string, options: ReadScalarOptions = {}): string {
  const value = matchScalar(block, key, "[ \\t]+");
  if (value === undefined) {
    if (options.required) throw new Error(`frontmatter missing ${key.trim()}`);
    return "";
  }
  return value.trim();
}

function matchScalar(body: string, key: string, prefix: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return body.match(new RegExp(`^${prefix}${escaped}:[ \\t]*(.*)$`, "mu"))?.[1];
}
