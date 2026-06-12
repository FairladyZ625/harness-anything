export interface SanitizedDocument {
  readonly html: string;
  readonly strippedReasons: readonly string[];
}

const unsafePatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/<script\b[\s\S]*?<\/script>/giu, "script-tag"],
  [/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "event-handler"],
  [/(?:\/Users|\/tmp|\/private\/var|\/var\/folders)\/[^\s"'<>]+/gu, "absolute-local-path"],
  [/\.harness-private(?:\/[^\s"'<>]*)?/gu, "private-harness-path"],
  [/\bauthorization\s*:\s*bearer\s+[^\s"'<>]+/giu, "secret-marker"],
  [/\b(?:api[_-]?key|access[_-]?token|token)\s*[:=]\s*[^\s"'<>]+/giu, "secret-marker"]
];

const urlAttributePattern = /\s(?:src|href|srcset|poster|data|action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;

export function sanitizeMarkdownHtml(input: string): SanitizedDocument {
  let html = input;
  const strippedReasons = new Set<string>();
  for (const [pattern, reason] of unsafePatterns) {
    html = html.replace(pattern, () => {
      strippedReasons.add(reason);
      return "";
    });
  }
  html = html.replace(urlAttributePattern, (attribute) => {
    const normalized = attribute.toLowerCase();
    const value = normalized.replace(/^[^=]+=\s*/, "").trim().replace(/^["']|["']$/g, "");
    if (value.startsWith("javascript:")) {
      strippedReasons.add("script-url");
      return "";
    }
    if (value.startsWith("data:")) {
      strippedReasons.add("data-embed");
      return "";
    }
    if (value.startsWith("file:")) {
      strippedReasons.add("file-embed");
      return "";
    }
    if (/(^|[\s,])(https?:|\/\/)/u.test(value)) {
      strippedReasons.add("remote-embed");
      return "";
    }
    return attribute;
  });
  return {
    html,
    strippedReasons: [...strippedReasons].sort()
  };
}
