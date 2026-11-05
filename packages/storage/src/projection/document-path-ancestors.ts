/** Raw path ancestors preserve the port's literal prefix semantics, including repeated slashes. */
export function documentPathAncestors(path: string): readonly string[] {
  const paths = [path];
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1))
    paths.push(path.slice(0, index));
  return paths;
}
