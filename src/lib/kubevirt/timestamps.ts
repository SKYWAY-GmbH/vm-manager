export type KubeTimestamp = Date | string;

export function timestampString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : value.toISOString();
  }

  return undefined;
}

export function firstTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = timestampString(value);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export function compareTimestampsDesc(left: unknown, right: unknown): number {
  return (timestampString(right) ?? "").localeCompare(timestampString(left) ?? "");
}
