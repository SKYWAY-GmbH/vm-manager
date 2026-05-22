"use client";

import { ArrowRight, Cpu, HardDrive, MemoryStick, Search, Server } from "lucide-react";
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
import type {
  ClusterNodeLoad,
  ClusterResourceLoad,
  VirtualMachineSummary,
  VmPowerState,
} from "@/lib/kubevirt/types";
import { cn } from "@/lib/utils";

const OVERVIEW_REFRESH_INTERVAL_MS = 5_000;

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

function percentText(percent: number | undefined) {
  return typeof percent === "number" ? `${Math.round(percent)}%` : "--";
}

function resourceText(resource: ClusterResourceLoad) {
  if (resource.used && resource.capacity) {
    return `${resource.used} / ${resource.capacity}`;
  }

  return resource.capacity ?? resource.used ?? "Unavailable";
}

function MetricBar({ percent }: { percent: number | undefined }) {
  return (
    <div className="h-1 w-full min-w-10 overflow-hidden rounded-sm bg-muted">
      <div
        className="h-full rounded-sm bg-primary"
        style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
      />
    </div>
  );
}

function NodeMetric({
  icon: Icon,
  label,
  resource,
}: {
  icon: typeof Cpu;
  label: string;
  resource: ClusterResourceLoad;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{label}</span>
        <span className="font-medium text-xs tabular-nums">{percentText(resource.percent)}</span>
      </div>
      <MetricBar percent={resource.percent} />
      <p className="truncate text-[0.68rem] text-muted-foreground tabular-nums">
        {resourceText(resource)}
      </p>
    </div>
  );
}

function ClusterLoadStrip({ nodes, error }: { nodes: ClusterNodeLoad[]; error?: string }) {
  if (nodes.length === 0 && !error) {
    return null;
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex h-10 items-center justify-between border-border border-b px-4">
        <h2 className="font-medium text-sm">Cluster load</h2>
        <span className="text-muted-foreground text-xs">5s refresh</span>
      </div>
      {error ? (
        <div className="border-border border-b px-4 py-2 text-amber-200 text-xs">{error}</div>
      ) : null}
      <div className="flex gap-0 overflow-x-auto">
        {nodes.map((node) => (
          <div
            key={node.name}
            className="grid min-w-[16rem] grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-border border-r px-3 py-2 last:border-r-0"
          >
            <div className="mt-0.5 flex size-7 items-center justify-center rounded-md border border-border bg-background">
              <Server className="size-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-2">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-medium text-xs">{node.name}</p>
                <span
                  className={cn(
                    "shrink-0 text-[0.68rem]",
                    node.ready === false ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {node.ready === false ? "Not ready" : node.roles.join(", ")}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <NodeMetric icon={Cpu} label="CPU" resource={node.cpu} />
                <NodeMetric icon={MemoryStick} label="Memory" resource={node.memory} />
                <NodeMetric icon={HardDrive} label="Storage" resource={node.storage} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
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
  nodes,
  error,
  metricsError,
}: {
  initialVms: VirtualMachineSummary[];
  nodes: ClusterNodeLoad[];
  error?: string;
  metricsError?: string;
}) {
  const [query, setQuery] = useState("");
  const filteredVms = useMemo(
    () => initialVms.filter((vm) => matchesVm(vm, query.trim())),
    [initialVms, query],
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
      <AutoRefresh intervalMs={OVERVIEW_REFRESH_INTERVAL_MS} />
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

      {!error ? <ClusterLoadStrip nodes={nodes} error={metricsError} /> : null}

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

      <p className="text-muted-foreground text-xs">Dashboard refreshes every 5 seconds.</p>
    </div>
  );
}
