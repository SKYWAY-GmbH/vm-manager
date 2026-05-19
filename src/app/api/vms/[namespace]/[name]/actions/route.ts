import { z } from "zod";
import { jsonData, jsonError } from "@/lib/api/response";
import { performVirtualMachineAction } from "@/lib/kubevirt/service";
import { vmActionSchema } from "@/lib/kubevirt/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const actionRequestSchema = z.object({
  action: vmActionSchema,
});

interface VmRouteContext {
  params: Promise<{
    namespace: string;
    name: string;
  }>;
}

export async function POST(request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    const body = actionRequestSchema.parse(await request.json());
    return jsonData(await performVirtualMachineAction(namespace, name, body.action));
  } catch (error) {
    return jsonError(error);
  }
}
