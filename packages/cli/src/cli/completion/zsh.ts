import type { CompletionCandidate, ShellCompletionModel } from "./model.ts";

export function generateZshCompletion(model: ShellCompletionModel): string {
  return [
    "#compdef ha harness-anything",
    "# Generated from the Harness Anything command registry. Do not edit.",
    "_ha_completion() {",
    "  local cur prev path i",
    "  local -a candidates",
    "  cur=\"${words[CURRENT]}\"",
    "  prev=\"\"",
    "  if (( CURRENT > 1 )); then prev=\"${words[CURRENT-1]}\"; fi",
    "  path=\"\"",
    "  for (( i=2; i<CURRENT; i++ )); do",
    "    path+=\"${path:+ }${words[i]}\"",
    "  done",
    "  case \"$path\" in",
    ...model.nodes.map((node) => zshNodeCase(node.path, node.children)),
    ...model.commands.map(zshCommandCase),
    "  esac",
    "}",
    "compdef _ha_completion ha harness-anything"
  ].join("\n");
}

function zshNodeCase(path: ReadonlyArray<string>, candidates: ReadonlyArray<CompletionCandidate>): string {
  return [
    `    ${quoteZshWord(path.join(" "))})`,
    "      candidates=(",
    ...candidates.map((candidate) => `        ${quoteZshWord(`${candidate.value}:${oneLine(candidate.description)}`)}`),
    "      )",
    "      _describe 'command' candidates",
    "      return",
    "      ;;"
  ].join("\n");
}

function zshCommandCase(command: ShellCompletionModel["commands"][number]): string {
  const path = command.path.join(" ");
  const lines = [
    `    ${quoteZshWord(path)}|${quoteZshWord(`${path} `)}*)`
  ];
  const valueOptions = command.options.filter((option) => option.values.length > 0);
  if (valueOptions.length > 0) {
    lines.push("      case \"$prev\" in");
    for (const option of valueOptions) {
      lines.push(
        `        ${quoteZshWord(option.value)}) _values 'value' ${option.values.map(quoteZshWord).join(" ")}; return ;;`
      );
    }
    lines.push("      esac");
  }
  for (const positional of command.positionals) {
    const current = command.path.length + positional.index + 2;
    lines.push(
      `      if (( CURRENT == ${current} )); then _values 'value' ${positional.values.map(quoteZshWord).join(" ")}; return; fi`
    );
  }
  lines.push(
    "      candidates=(",
    ...command.options.map((option) => `        ${quoteZshWord(`${option.value}:${oneLine(option.description)}`)}`),
    "      )",
    "      _describe 'option' candidates",
    "      return",
    "      ;;"
  );
  return lines.join("\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function quoteZshWord(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
