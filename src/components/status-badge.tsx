import { Badge } from "@/components/ui/badge";
import type { VmPowerState } from "@/lib/kubevirt/types";
import { cn } from "@/lib/utils";

const stateClasses: Record<VmPowerState, string> = {
  online: "border-emerald-500/30 bg-emerald-500/12 text-emerald-200",
  offline: "border-stone-500/30 bg-stone-500/12 text-stone-300",
  transitioning: "border-amber-500/35 bg-amber-500/12 text-amber-200",
  unknown: "border-zinc-500/30 bg-zinc-500/12 text-zinc-300",
};

export function PowerStateBadge({ state }: { state: VmPowerState }) {
  return (
    <Badge variant="outline" className={cn("rounded-md capitalize", stateClasses[state])}>
      {state}
    </Badge>
  );
}

export function ReadinessBadge({ ready }: { ready: boolean | null }) {
  const label = ready === true ? "Ready" : ready === false ? "Not ready" : "Unknown";
  const className =
    ready === true
      ? "border-emerald-500/30 bg-emerald-500/12 text-emerald-200"
      : ready === false
        ? "border-red-500/30 bg-red-500/12 text-red-200"
        : "border-zinc-500/30 bg-zinc-500/12 text-zinc-300";

  return (
    <Badge variant="outline" className={cn("rounded-md", className)}>
      {label}
    </Badge>
  );
}

export function SnapshotReadyBadge({ ready }: { ready: boolean | null }) {
  const label = ready === true ? "Ready" : ready === false ? "Pending" : "Unknown";
  const className =
    ready === true
      ? "border-emerald-500/30 bg-emerald-500/12 text-emerald-200"
      : "border-amber-500/35 bg-amber-500/12 text-amber-200";

  return (
    <Badge variant="outline" className={cn("rounded-md", className)}>
      {label}
    </Badge>
  );
}
