import { jsonData, jsonError } from "@/lib/api/response";
import { getVirtualMachine } from "@/lib/kubevirt/service";

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
    return jsonData(await getVirtualMachine(namespace, name));
  } catch (error) {
    return jsonError(error);
  }
}
