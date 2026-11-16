// The command token is the first argv entry that is neither a flag nor a global's value. Deciding a
// route by scanning the whole argv instead lets any flag *value* that happens to spell a command name
// hijack it — `--title daemon` is a legitimate invocation that must not route to the `daemon` domain.
export function firstCliCommandIndex(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root" || value === "--repo") {
      index += 1;
      continue;
    }
    if (value?.startsWith("-")) continue;
    return index;
  }
  return -1;
}
