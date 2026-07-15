export function scriptChildEnvironment(
  declared: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(declared).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}
