const CPU_SUFFIX_MULTIPLIERS: Record<string, number> = {
  n: 0.000001,
  u: 0.001,
  m: 1,
  "": 1000,
};

const BYTE_SUFFIX_MULTIPLIERS: Record<string, number> = {
  "": 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
};

function trimNumber(value: number, fractionDigits = 1): string {
  return value.toLocaleString("en", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
}

export function parseCpuQuantity(value: number | string | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value * 1000 : undefined;
  }

  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^([0-9]*\.?[0-9]+)(n|u|m)?$/);
  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1]);
  const suffix = match[2] ?? "";
  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return amount * CPU_SUFFIX_MULTIPLIERS[suffix];
}

export function parseByteQuantity(value: number | string | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^([0-9]*\.?[0-9]+)(Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K)?$/);
  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1]);
  const suffix = match[2] ?? "";
  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return amount * BYTE_SUFFIX_MULTIPLIERS[suffix];
}

export function formatCpuQuantity(value: number | string | undefined): string | undefined {
  const millicores = parseCpuQuantity(value);
  if (millicores === undefined) {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  if (millicores >= 1000) {
    return `${trimNumber(millicores / 1000, 2)} CPU`;
  }

  return `${trimNumber(millicores, 0)}m CPU`;
}

export function formatByteQuantity(value: number | string | undefined): string | undefined {
  const bytes = parseByteQuantity(value);
  if (bytes === undefined) {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  const units = [
    { suffix: "TiB", value: 1024 ** 4 },
    { suffix: "GiB", value: 1024 ** 3 },
    { suffix: "MiB", value: 1024 ** 2 },
    { suffix: "KiB", value: 1024 },
  ];
  const unit = units.find((candidate) => Math.abs(bytes) >= candidate.value);
  if (!unit) {
    return `${trimNumber(bytes, 0)} B`;
  }

  const amount = bytes / unit.value;
  return `${trimNumber(amount, amount >= 10 ? 1 : 2)} ${unit.suffix}`;
}

export function resourcePercent(used: number | undefined, capacity: number | undefined) {
  if (used === undefined || capacity === undefined || capacity <= 0) {
    return undefined;
  }

  return Math.max(0, Math.min(100, (used / capacity) * 100));
}
