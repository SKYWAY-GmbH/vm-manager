import { jsonData, jsonError } from "@/lib/api/response";
import { forceClearVirtualMachineOperation } from "@/lib/kubevirt/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VmRouteContext {
  params: Promise<{
    namespace: string;
    name: string;
  }>;
}

export async function DELETE(_request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    return jsonData(await forceClearVirtualMachineOperation(namespace, name));
  } catch (error) {
    return jsonError(error);
  }
}
