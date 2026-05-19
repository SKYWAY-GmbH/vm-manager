import { toApiError } from "@/lib/kubevirt/errors";

function noStoreInit(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }

  return { ...init, headers };
}

export function jsonData<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, noStoreInit(init));
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
    noStoreInit({ status: apiError.status }),
  );
}
