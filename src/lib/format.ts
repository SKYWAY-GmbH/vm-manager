export function formatDateTime(value?: string): string {
  if (!value) {
    return "Unavailable";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatReady(value: boolean | null): string {
  if (value === true) {
    return "Ready";
  }

  if (value === false) {
    return "Not ready";
  }

  return "Unknown";
}

export function formatIpList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "No IP";
}
