import { jsonData, jsonError } from "@/lib/api/response";
import { createVirtualMachineBackup, listVirtualMachineBackups } from "@/lib/kubevirt/service";
import { createBackupSchema } from "@/lib/kubevirt/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VmRouteContext {
  params: Promise<{
    namespace: string;
    name: string;
  }>;
}

export async function GET(_request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    return jsonData(await listVirtualMachineBackups(namespace, name));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    const body = createBackupSchema.parse(await request.json());
    return jsonData(await createVirtualMachineBackup(namespace, name, body.name, body.backupMode), {
      status: 201,
    });
  } catch (error) {
    return jsonError(error);
  }
}
