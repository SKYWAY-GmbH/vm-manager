import { jsonData, jsonError } from "@/lib/api/response";
import { discardVirtualMachineRollback } from "@/lib/kubevirt/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VmRollbackRouteContext {
  params: Promise<{
    namespace: string;
    name: string;
    pvName: string;
  }>;
}

export async function DELETE(_request: Request, context: VmRollbackRouteContext) {
  try {
    const { namespace, name, pvName } = await context.params;
    return jsonData(await discardVirtualMachineRollback(namespace, name, pvName));
  } catch (error) {
    return jsonError(error);
  }
}
