import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SnapshotControls } from "@/components/snapshot-controls";
import { PowerStateBadge, ReadinessBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VmActionMenu } from "@/components/vm-action-menu";
import { formatDateTime, formatIpList, formatReady } from "@/lib/format";
import type { VirtualMachineDetail } from "@/lib/kubevirt/types";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="truncate text-sm">{value}</p>
    </div>
  );
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
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-semibold text-2xl tracking-normal">{vm.name}</h1>
              <PowerStateBadge state={vm.powerState} />
              <ReadinessBadge ready={vm.ready} />
            </div>
            <p className="mt-1 text-muted-foreground text-sm">{vm.namespace}</p>
          </div>
          <VmActionMenu vm={vm} />
        </div>
      </header>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-sm">Current state</h2>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Printable status" value={vm.printableStatus} />
          <Field label="Readiness" value={formatReady(vm.ready)} />
          <Field label="Node" value={vm.nodeName ?? "Unscheduled"} />
          <Field label="Run strategy" value={vm.runStrategy} />
          <Field label="IP addresses" value={formatIpList(vm.ipAddresses)} />
          <Field label="Created" value={formatDateTime(vm.createdAt)} />
          <Field label="UID" value={vm.uid ?? "Unavailable"} />
          <Field label="Operations" value={vm.activeOperations.length.toString()} />
        </div>
        {vm.activeOperations.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-wrap gap-2 p-4">
              {vm.activeOperations.map((operation) => (
                <Badge
                  key={`${operation.type}-${operation.name}`}
                  variant="outline"
                  className="rounded-md"
                >
                  {operation.type}: {operation.name} ({operation.phase})
                </Badge>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <SnapshotControls vm={vm} />

      <section className="rounded-lg border border-border bg-card">
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-sm">Restore history</h2>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Snapshot</TableHead>
                <TableHead>Phase</TableHead>
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
        {vm.restores.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground text-sm">
            No restore history exists for this VM.
          </div>
        ) : null}
      </section>
    </div>
  );
}
