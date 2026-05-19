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

export function formatElapsedSince(value?: string): string {
  if (!value) {
    return "Unknown";
  }

  const started = new Date(value).getTime();
  if (Number.isNaN(started)) {
    return "Unknown";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  return remainingMinutes > 0 ? `${elapsedHours}h ${remainingMinutes}m` : `${elapsedHours}h`;
}
