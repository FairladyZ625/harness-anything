export function lifecycleReason(reason: string, fields: Readonly<Record<string, string | undefined>>): string {
  const suffix = Object.entries(fields)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  return suffix ? `${reason}\n\nMetadata: ${suffix}` : reason;
}
