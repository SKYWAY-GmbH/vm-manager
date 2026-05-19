import { jsonData, jsonError } from "@/lib/api/response";
import { createVirtualMachineSnapshot, listVirtualMachineSnapshots } from "@/lib/kubevirt/service";
import { createSnapshotSchema } from "@/lib/kubevirt/validation";

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
    return jsonData(await listVirtualMachineSnapshots(namespace, name));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    const body = createSnapshotSchema.parse(await request.json());
    return jsonData(await createVirtualMachineSnapshot(namespace, name, body.name), {
      status: 201,
    });
  } catch (error) {
    return jsonError(error);
  }
}
