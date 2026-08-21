export function ftsQuery(value: string): string { return `"${value.trim().replaceAll('"', '""')}"`; }
