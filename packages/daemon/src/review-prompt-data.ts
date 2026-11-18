/** Repository text is data in a review mission. Keep its JSON on one physical line. */
function encode(value: unknown): string {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029<>]/gu, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

export function reviewPromptData(label: string, data: unknown): string {
  return `<${label}>\n${encode(data)}\n</${label}>`;
}

export function reviewDataPreview(value: string, limit: number): string {
  if (encode(value).length <= limit) return value;
  // Each UTF-16 unit needs at most six JSON characters. Reserve space for quotes and the ellipsis.
  return `${value.slice(0, Math.floor((limit - 3) / 6))}…`;
}
