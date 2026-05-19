import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { VmDetail } from "@/components/vm-detail";
import { getErrorStatus } from "@/lib/kubevirt/errors";
import { getVirtualMachine } from "@/lib/kubevirt/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VmPageProps {
  params: Promise<{
    namespace: string;
    name: string;
  }>;
}

export default async function VmPage({ params }: VmPageProps) {
  const { namespace, name } = await params;

  try {
    const vm = await getVirtualMachine(namespace, name);
    return (
      <AppShell>
        <VmDetail vm={vm} />
      </AppShell>
    );
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      notFound();
    }

    throw error;
  }
}
