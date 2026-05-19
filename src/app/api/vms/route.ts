import { jsonData, jsonError } from "@/lib/api/response";
import { listVirtualMachines } from "@/lib/kubevirt/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return jsonData(await listVirtualMachines());
  } catch (error) {
    return jsonError(error);
  }
}
