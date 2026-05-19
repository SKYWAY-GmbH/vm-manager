import { jsonData, jsonError } from "@/lib/api/response";
import { createVirtualMachineRestore, listVirtualMachineRestores } from "@/lib/kubevirt/service";
import { createRestoreSchema } from "@/lib/kubevirt/validation";

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
    return jsonData(await listVirtualMachineRestores(namespace, name));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    const body = createRestoreSchema.parse(await request.json());
    return jsonData(
      await createVirtualMachineRestore(namespace, name, body.snapshotName, body.restoreName),
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
