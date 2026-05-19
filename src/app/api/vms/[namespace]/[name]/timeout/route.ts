import { z } from "zod";
import { jsonData, jsonError } from "@/lib/api/response";
import { resetVirtualMachineManualRuntimeTimeout } from "@/lib/kubevirt/service";
import { manualRuntimeDurationDaysSchema } from "@/lib/kubevirt/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const timeoutRequestSchema = z.object({
  timeoutDays: manualRuntimeDurationDaysSchema,
});

interface VmRouteContext {
  params: Promise<{
    namespace: string;
    name: string;
  }>;
}

export async function PUT(request: Request, context: VmRouteContext) {
  try {
    const { namespace, name } = await context.params;
    const body = timeoutRequestSchema.parse(await request.json());
    return jsonData(
      await resetVirtualMachineManualRuntimeTimeout(namespace, name, body.timeoutDays),
    );
  } catch (error) {
    return jsonError(error);
  }
}
