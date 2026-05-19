import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SnapshotControls } from "@/components/snapshot-controls";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  return operation.type === "restore" ? "Restore in progress" : "Snapshot in progress";
}

function operationSubject(operation: VmOperation) {
  if (operation.type === "restore" && operation.snapshotName) {
    return `Restoring from ${operation.snapshotName}`;
  }

  if (operation.type === "snapshot") {
    return `Creating ${operation.name}`;
  }

  return operation.name;
}

export function VmDetail({ vm }: { vm: VirtualMachineDetail }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
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

      <section className="rounded-lg border border-border bg-card">
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-sm">Restore history</h2>
        </div>
        <div className="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Snapshot</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vm.restores.map((restore) => (
                <TableRow key={restore.name}>
                  <TableCell className="font-medium">{restore.name}</TableCell>
                  <TableCell>{restore.snapshotName ?? "Unknown"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {restore.message ?? restore.phase}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDateTime(restore.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="divide-y divide-border md:hidden">
          {vm.restores.map((restore) => (
            <div key={restore.name} className="space-y-3 p-4">
              <div className="min-w-0">
                <p className="break-words font-medium text-sm">{restore.name}</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  Snapshot: {restore.snapshotName ?? "Unknown"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Status" value={restore.message ?? restore.phase} />
                <Field label="Created" value={formatDateTime(restore.createdAt)} />
              </div>
            </div>
          ))}
        </div>
        {vm.restores.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground text-sm">
            No restore history exists for this VM.
          </div>
        ) : null}
      </section>
    </div>
  );
}
