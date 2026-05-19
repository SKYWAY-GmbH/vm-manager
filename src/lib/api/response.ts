import { toApiError } from "@/lib/kubevirt/errors";

export function jsonData<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

export function jsonError(error: unknown): Response {
  const apiError = toApiError(error);

  if (apiError.status >= 500) {
    console.error(apiError);
  }

  return Response.json(
    {
      error: {
        message: apiError.message,
        status: apiError.status,
      },
    },
    { status: apiError.status },
  );
}
