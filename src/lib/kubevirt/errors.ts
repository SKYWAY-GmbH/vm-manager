import { z } from "zod";

function readQuotedValue(value: string): string | undefined {
  if (!value.startsWith('"')) {
    return undefined;
  }

  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      return value.slice(0, index + 1);
    }
  }

  return undefined;
}

function parseKubernetesStatusMessage(message: string): string | undefined {
  const bodyMarker = " Body: ";
  const bodyIndex = message.indexOf(bodyMarker);
  if (bodyIndex === -1) {
    return undefined;
  }

  const bodyAndRemainder = message.slice(bodyIndex + bodyMarker.length).trimStart();
  const rawBody = bodyAndRemainder.startsWith('"')
    ? readQuotedValue(bodyAndRemainder)
    : bodyAndRemainder.split(" Headers: ")[0];

  if (!rawBody) {
    return undefined;
  }

  try {
    const bodyText = rawBody.startsWith('"') ? (JSON.parse(rawBody) as unknown) : rawBody;
    if (typeof bodyText !== "string") {
      return undefined;
    }

    const body = JSON.parse(bodyText) as unknown;
    if (typeof body === "object" && body !== null && "message" in body) {
      const statusMessage = body.message;
      return typeof statusMessage === "string" ? statusMessage : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function normalizeKubernetesErrorMessage(message: string): string {
  const statusMessage = parseKubernetesStatusMessage(message) ?? message;

  if (statusMessage.includes("snapshot feature gate not enabled")) {
    return "KubeVirt snapshot support is disabled in this cluster. Enable the Snapshot feature gate in the KubeVirt CR, then try again.";
  }

  return statusMessage;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(normalizeKubernetesErrorMessage(message));
    this.name = "ApiError";
    this.status = status;
  }
}

export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) {
    return error.status;
  }

  if (typeof error === "object" && error !== null) {
    const status =
      "statusCode" in error
        ? error.statusCode
        : "status" in error
          ? error.status
          : "code" in error
            ? error.code
            : undefined;
    if (typeof status === "number") {
      return status;
    }
  }

  return undefined;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof z.ZodError) {
    return new ApiError(400, error.issues[0]?.message ?? "Invalid request.");
  }

  const status = getErrorStatus(error);
  if (typeof status === "number") {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? normalizeKubernetesErrorMessage(String(error.message))
        : "Kubernetes API request failed.";
    return new ApiError(status, message);
  }

  if (error instanceof Error) {
    return new ApiError(500, normalizeKubernetesErrorMessage(error.message));
  }

  return new ApiError(500, "Unexpected error.");
}
