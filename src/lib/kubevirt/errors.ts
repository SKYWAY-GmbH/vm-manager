import { z } from "zod";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
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
      "statusCode" in error ? error.statusCode : "status" in error ? error.status : undefined;
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
        ? String(error.message)
        : "Kubernetes API request failed.";
    return new ApiError(status, message);
  }

  if (error instanceof Error) {
    return new ApiError(500, error.message);
  }

  return new ApiError(500, "Unexpected error.");
}
