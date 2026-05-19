"use client";

import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VmActionButtons } from "@/components/vm-action-menu";
import { formatElapsedSince, formatReady } from "@/lib/format";
import type { VirtualMachineSummary, VmPowerState } from "@/lib/kubevirt/types";
import { cn } from "@/lib/utils";

function vmHref(vm: VirtualMachineSummary) {
  return `/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}`;
}

function activityLabel(vm: VirtualMachineSummary) {
  if (vm.activeOperations.length === 0) {
    return "Idle";
  }

  return vm.activeOperations
    .map((operation) => {
      const type =
        operation.type === "restore"
          ? "Restore"
          : operation.type === "backup"
            ? "Backup"
            : operation.type === "cleanup"
              ? "Cleanup"
              : "Snapshot";
      const elapsed = operation.createdAt ? `, ${formatElapsedSince(operation.createdAt)}` : "";
      return `${type}: ${operation.phase}${elapsed}`;
    })
    .join(", ");
}

const lifecycleTextClasses: Record<VmPowerState, string> = {
  online: "text-emerald-200",
  offline: "text-stone-300",
  transitioning: "text-amber-200",
  unknown: "text-zinc-300",
};

function VmLifecycleText({ vm }: { vm: VirtualMachineSummary }) {
  const runningText =
    vm.powerState === "online" && vm.runningSince
      ? `Running ${formatElapsedSince(vm.runningSince)}`
      : formatReady(vm.ready);

  return (
    <div className="space-y-0.5">
      <p className={cn("font-medium text-sm", lifecycleTextClasses[vm.powerState])}>
        {vm.printableStatus}
      </p>
      <p className="text-muted-foreground text-xs">{runningText}</p>
    </div>
  );
}

function matchesVm(vm: VirtualMachineSummary, query: string) {
  const haystack = [vm.name, vm.namespace, vm.printableStatus, vm.nodeName, activityLabel(vm)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

export function VmOverview({
  initialVms,
  error,
}: {
  initialVms: VirtualMachineSummary[];
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const filteredVms = useMemo(
    () => initialVms.filter((vm) => matchesVm(vm, query.trim())),
    [initialVms, query],
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
      <AutoRefresh />
      <header className="flex flex-col gap-4 border-border border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="font-semibold text-2xl tracking-normal">Virtual machines</h1>
          <p className="max-w-2xl text-muted-foreground text-sm">
            Cluster-wide KubeVirt inventory and power controls.
          </p>
        </div>
        <div className="relative w-full lg:w-80">
          <Search
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter VMs"
            className="h-9 pl-9"
          />
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive text-sm">
          {error}
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-card">
        <div className="flex h-12 items-center justify-between border-border border-b px-4">
          <h2 className="font-medium text-sm">Inventory</h2>
          <span className="text-muted-foreground text-xs">
            {filteredVms.length} of {initialVms.length}
          </span>
        </div>

        <div className="hidden overflow-x-auto md:block">
          <Table className="min-w-[67rem] table-fixed">
            <colgroup>
              <col className="w-[17rem]" />
              <col className="w-[11rem]" />
              <col className="w-[11rem]" />
              <col className="w-[6rem]" />
              <col className="w-[22rem]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>VM</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredVms.map((vm) => (
                <TableRow key={vm.id}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col">
                      <Link href={vmHref(vm)} className="truncate font-medium hover:text-primary">
                        {vm.name}
                      </Link>
                      <span className="text-muted-foreground text-xs">{vm.namespace}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <VmLifecycleText vm={vm} />
                  </TableCell>
                  <TableCell className="text-sm">{vm.nodeName ?? "Unscheduled"}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground text-sm">
                    {activityLabel(vm)}
                  </TableCell>
                  <TableCell className="text-right">
                    <VmActionButtons vm={vm} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y divide-border md:hidden">
          {filteredVms.map((vm) => (
            <div key={vm.id} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={vmHref(vm)} className="block truncate font-medium">
                    {vm.name}
                  </Link>
                  <p className="text-muted-foreground text-xs">{vm.namespace}</p>
                </div>
              </div>
              <VmActionButtons vm={vm} className="flex-wrap justify-start" />
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs">Lifecycle</p>
                  <VmLifecycleText vm={vm} />
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">Node</p>
                  <p className="truncate">{vm.nodeName ?? "Unscheduled"}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">Activity</p>
                  <p className="truncate">{activityLabel(vm)}</p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href={vmHref(vm)}>
                  Details
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          ))}
        </div>

        {filteredVms.length === 0 ? (
          <div className="px-4 py-12 text-center text-muted-foreground text-sm">
            {initialVms.length === 0
              ? "No virtual machines were returned."
              : "No VMs match the filter."}
          </div>
        ) : null}
      </section>

      <p className="text-muted-foreground text-xs">Inventory refreshes every second.</p>
    </div>
  );
}
