interface LocalDateParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

function localDateParts(iso: string): LocalDateParts | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    year: String(date.getFullYear()).padStart(4, "0"),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hour: pad(date.getHours()),
    minute: pad(date.getMinutes()),
    second: pad(date.getSeconds()),
  };
}

/** Stable numeric display using the process/system local timezone. */
export function localDateTime(iso: string, includeSeconds = false): string | null {
  const value = localDateParts(iso);
  return value
    ? `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}${includeSeconds ? `:${value.second}` : ""}`
    : null;
}

export function localMonthDayTime(iso: string): string | null {
  const value = localDateParts(iso);
  return value ? `${value.month}-${value.day} ${value.hour}:${value.minute}` : null;
}

export function localTime(iso: string, includeSeconds = false): string | null {
  const value = localDateParts(iso);
  return value ? `${value.hour}:${value.minute}${includeSeconds ? `:${value.second}` : ""}` : null;
}
