import { AppShell } from "@/components/app-shell";
import { VmOverview } from "@/components/vm-overview";
import { toApiError } from "@/lib/kubevirt/errors";
import { listClusterNodeMetrics, listVirtualMachines } from "@/lib/kubevirt/service";
import type { ClusterNodeLoad, VirtualMachineSummary } from "@/lib/kubevirt/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = {
  title: "Virtual machines | SKYWAY VM Manager",
};

function formatLoadError(message: string) {
  if (message.includes("localhost:8080") || message.includes("HTTP protocol is not allowed")) {
    return "Kubernetes is not reachable from this environment. Set KUBECONFIG for local development or run the app inside the cluster.";
  }

  return message;
}

export default async function Home() {
  let vms: VirtualMachineSummary[] = [];
  let nodes: ClusterNodeLoad[] = [];
  let error: string | undefined;
  let metricsError: string | undefined;

  try {
    vms = await listVirtualMachines();
  } catch (caught) {
    const apiError = toApiError(caught);
    error = formatLoadError(apiError.message);
  }

  if (!error) {
    try {
      nodes = await listClusterNodeMetrics();
    } catch (caught) {
      const apiError = toApiError(caught);
      metricsError = formatLoadError(apiError.message);
    }
  }

  return (
    <AppShell>
      <VmOverview initialVms={vms} nodes={nodes} error={error} metricsError={metricsError} />
    </AppShell>
  );
}
