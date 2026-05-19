import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { SnapshotControls } from "@/components/snapshot-controls";
import { Button } from "@/components/ui/button";
import { VmActionButtons } from "@/components/vm-action-menu";
import { formatDateTime, formatElapsedSince, formatIpList, formatReady } from "@/lib/format";
import type { VirtualMachineDetail, VmOperation } from "@/lib/kubevirt/types";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="truncate text-sm">{value}</p>
    </div>
  );
}

function operationTitle(operation: VmOperation) {
  if (operation.type === "backup") {
    return "Backup in progress";
  }

  if (operation.type === "restore") {
    return "Restore in progress";
  }

  if (operation.type === "cleanup") {
    return "Cleanup in progress";
  }

  return "Snapshot in progress";
}

function operationSubject(operation: VmOperation) {
  if (operation.type === "restore" && operation.snapshotName) {
    return `Restoring from ${operation.snapshotName}`;
  }

  if (operation.type === "snapshot") {
    return `Creating ${operation.name}`;
  }

  if (operation.type === "backup") {
    return `Creating ${operation.name}`;
  }

  return operation.name;
}

export function VmDetail({ vm }: { vm: VirtualMachineDetail }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
      <AutoRefresh />
      <header className="space-y-4 border-border border-b pb-5">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back
          </Link>
        </Button>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-2xl tracking-normal">{vm.name}</h1>
            <p className="mt-1 text-muted-foreground text-sm">{vm.namespace}</p>
          </div>
          <VmActionButtons vm={vm} />
        </div>
      </header>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-sm">Current state</h2>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status" value={vm.printableStatus} />
          <Field label="Readiness" value={formatReady(vm.ready)} />
          <Field label="Node" value={vm.nodeName ?? "Unscheduled"} />
          <Field label="Lifecycle mode" value={vm.runStrategy} />
          <Field label="IP addresses" value={formatIpList(vm.ipAddresses)} />
          <Field label="Created" value={formatDateTime(vm.createdAt)} />
          <Field label="UID" value={vm.uid ?? "Unavailable"} />
        </div>
        {vm.activeOperations.length > 0 ? (
          <div className="border-border border-t">
            {vm.activeOperations.map((operation) => (
              <div
                key={`${operation.type}-${operation.name}`}
                className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(12rem,1fr)_10rem_8rem]"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm">{operationTitle(operation)}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    {operationSubject(operation)}
                  </p>
                  {operation.message ? (
                    <p className="mt-1 text-muted-foreground text-xs">{operation.message}</p>
                  ) : null}
                </div>
                <Field label="Status" value={operation.phase} />
                <Field label="Elapsed" value={formatElapsedSince(operation.createdAt)} />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <SnapshotControls vm={vm} />
    </div>
  );
}
