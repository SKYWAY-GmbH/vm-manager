import { jsonData, jsonError } from "@/lib/api/response";
import { ApiError } from "@/lib/kubevirt/errors";
import { restoreVirtualMachineBackup, restoreVirtualMachineSnapshot } from "@/lib/kubevirt/service";
import { createRestoreSchema } from "@/lib/kubevirt/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VmRouteContext {
  params: Promise<{
    namespace: string;
    name: string;
  }>;
}

export async function POST(request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    const body = createRestoreSchema.parse(await request.json());
    const sourceType = body.sourceType ?? (body.backupName ? "backup" : "snapshot");

    if (sourceType === "backup") {
      if (!body.backupName) {
        throw new ApiError(400, "backupName is required for backup restores.");
      }

      return jsonData(await restoreVirtualMachineBackup(namespace, name, body.backupName), {
        status: 201,
      });
    }

    if (!body.snapshotName) {
      throw new ApiError(400, "snapshotName is required for snapshot restores.");
    }

    return jsonData(await restoreVirtualMachineSnapshot(namespace, name, body.snapshotName), {
      status: 201,
    });
  } catch (error) {
    return jsonError(error);
  }
}
