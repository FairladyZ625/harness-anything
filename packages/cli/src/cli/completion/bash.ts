import type { ShellCompletionModel } from "./model.ts";

export function generateBashCompletion(model: ShellCompletionModel): string {
  return [
    "# bash completion for ha and harness-anything",
    "# Generated from the Harness Anything command registry. Do not edit.",
    "_ha_completion() {",
    "  local cur prev path i",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  prev=\"\"",
    "  if (( COMP_CWORD > 0 )); then prev=\"${COMP_WORDS[COMP_CWORD-1]}\"; fi",
    "  path=\"\"",
    "  for (( i=1; i<COMP_CWORD; i++ )); do",
    "    path+=\"${path:+ }${COMP_WORDS[i]}\"",
    "  done",
    "  case \"$path\" in",
    ...model.nodes.map((node) => bashNodeCase(node.path, node.children.map((child) => child.value))),
    ...model.commands.map(bashCommandCase),
    "  esac",
    "}",
    "complete -F _ha_completion ha harness-anything"
  ].join("\n");
}

function bashNodeCase(path: ReadonlyArray<string>, candidates: ReadonlyArray<string>): string {
  return [
    `    ${quoteBashWord(path.join(" "))})`,
    `      COMPREPLY=( $(compgen -W ${quoteBashWord(candidates.join(" "))} -- "$cur") )`,
    "      return",
    "      ;;"
  ].join("\n");
}

function bashCommandCase(command: ShellCompletionModel["commands"][number]): string {
  const path = command.path.join(" ");
  const lines = [
    `    ${quoteBashWord(path)}|${quoteBashWord(`${path} `)}*)`
  ];
  const valueOptions = command.options.filter((option) => option.values.length > 0);
  if (valueOptions.length > 0) {
    lines.push("      case \"$prev\" in");
    for (const option of valueOptions) {
      lines.push(
        `        ${quoteBashWord(option.value)}) COMPREPLY=( $(compgen -W ${quoteBashWord(option.values.join(" "))} -- "$cur") ); return ;;`
      );
    }
    lines.push("      esac");
  }
  for (const positional of command.positionals) {
    const cword = command.path.length + positional.index + 1;
    lines.push(
      `      if (( COMP_CWORD == ${cword} )); then COMPREPLY=( $(compgen -W ${quoteBashWord(positional.values.join(" "))} -- "$cur") ); return; fi`
    );
  }
  lines.push(
    `      COMPREPLY=( $(compgen -W ${quoteBashWord(command.options.map((option) => option.value).join(" "))} -- "$cur") )`,
    "      return",
    "      ;;"
  );
  return lines.join("\n");
}

function quoteBashWord(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
