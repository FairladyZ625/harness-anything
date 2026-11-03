/** Render one command and its arguments as a POSIX-shell-safe line. */
export function formatShellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuoteArgument).join(" ");
}

function shellQuoteArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  const quote = "'";
  return `${quote}${value.replaceAll(quote, `${quote}"${quote}"${quote}`)}${quote}`;
}
