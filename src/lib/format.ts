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

export function formatTimeUntil(value?: string): string {
  if (!value) {
    return "Set timer";
  }

  const expires = new Date(value).getTime();
  if (Number.isNaN(expires)) {
    return "Set timer";
  }

  const remainingSeconds = Math.ceil((expires - Date.now()) / 1000);
  if (remainingSeconds <= 0) {
    return "Due now";
  }

  if (remainingSeconds < 60) {
    return `${remainingSeconds}s left`;
  }

  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) {
    return `${remainingMinutes}m left`;
  }

  const remainingHours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (remainingHours < 24) {
    return minutes > 0 ? `${remainingHours}h ${minutes}m left` : `${remainingHours}h left`;
  }

  const days = Math.floor(remainingHours / 24);
  const hours = remainingHours % 24;
  return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
}
