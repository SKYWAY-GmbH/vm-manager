"use client";

import { Clock, Loader2, Play, Power, RotateCw, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTimeUntil } from "@/lib/format";
import type {
  ManualRuntimeDurationDays,
  VirtualMachineSummary,
  VmAction,
} from "@/lib/kubevirt/types";
import { validateActionForVm } from "@/lib/kubevirt/validation";
import { cn } from "@/lib/utils";

const actions: Array<{
  action: VmAction;
  label: string;
  description: string;
  icon: typeof Play;
  destructive?: boolean;
  requiresConfirmation?: boolean;
}> = [
  {
    action: "start",
    label: "Start",
    description: "Start this virtual machine.",
    icon: Play,
  },
  {
    action: "stop",
    label: "Stop",
    description: "Ask the guest to shut down cleanly.",
    icon: Square,
    requiresConfirmation: true,
  },
  {
    action: "reboot",
    label: "Reboot",
    description: "Restart the guest operating system.",
    icon: RotateCw,
    requiresConfirmation: true,
  },
  {
    action: "force-stop",
    label: "Force",
    description: "Cut power immediately. Unsaved guest data can be lost.",
    icon: Power,
    destructive: true,
    requiresConfirmation: true,
  },
];

const iconOnlyActions = new Set<VmAction>(["start", "stop", "reboot"]);

function actionEndpoint(vm: VirtualMachineSummary) {
  return `/api/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}/actions`;
}

function timeoutEndpoint(vm: VirtualMachineSummary) {
  return `/api/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}/timeout`;
}

function durationLabel(durationDays: ManualRuntimeDurationDays) {
  return durationDays === 1 ? "1 day" : `${durationDays} days`;
}

export function VmActionButtons({
  vm,
  className,
}: {
  vm: VirtualMachineSummary;
  className?: string;
}) {
  const { refresh } = useRouter();
  const [pendingAction, setPendingAction] = useState<(typeof actions)[number] | null>(null);
  const [runtimeDialogMode, setRuntimeDialogMode] = useState<"start" | "reset" | null>(null);
  const [runtimeDays, setRuntimeDays] = useState<ManualRuntimeDurationDays>(
    vm.manualRuntime?.durationDays ?? 7,
  );
  const [activeAction, setActiveAction] = useState<VmAction | null>(null);
  const [isResettingRuntime, setIsResettingRuntime] = useState(false);
  const [isPending, startTransition] = useTransition();
  const startAction = actions.find((item) => item.action === "start");
  const showRuntimeReset = vm.runStrategy === "Manual" && vm.powerState === "online";

  function openRuntimeDialog(mode: "start" | "reset") {
    setRuntimeDays(vm.manualRuntime?.durationDays ?? 7);
    setRuntimeDialogMode(mode);
  }

  async function runAction(
    nextAction: (typeof actions)[number],
    options: { timeoutDays?: ManualRuntimeDurationDays } = {},
  ) {
    const validation = validateActionForVm(nextAction.action, vm);
    if (!validation.ok) {
      toast.error(validation.reason);
      return;
    }

    startTransition(async () => {
      setActiveAction(nextAction.action);
      try {
        const response = await fetch(actionEndpoint(vm), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: nextAction.action,
            ...(options.timeoutDays === undefined ? {} : { timeoutDays: options.timeoutDays }),
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(payload?.error?.message ?? "VM action failed.");
          return;
        }

        toast.success(`${nextAction.label} submitted for ${vm.name}.`);
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "VM action failed.");
      } finally {
        setActiveAction(null);
      }
    });
  }

  async function resetRuntimeTimeout(timeoutDays: ManualRuntimeDurationDays) {
    startTransition(async () => {
      setIsResettingRuntime(true);
      try {
        const response = await fetch(timeoutEndpoint(vm), {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ timeoutDays }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(payload?.error?.message ?? "Runtime timeout reset failed.");
          return;
        }

        toast.success(`Runtime timeout reset for ${vm.name}.`);
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Runtime timeout reset failed.");
      } finally {
        setIsResettingRuntime(false);
      }
    });
  }

  function submitRuntimeDialog() {
    if (runtimeDialogMode === "start" && startAction) {
      void runAction(startAction, { timeoutDays: runtimeDays });
    }

    if (runtimeDialogMode === "reset") {
      void resetRuntimeTimeout(runtimeDays);
    }

    setRuntimeDialogMode(null);
  }

  return (
    <TooltipProvider>
      <div className={cn("flex flex-nowrap justify-end gap-1.5", className)}>
        {showRuntimeReset ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={isPending || isResettingRuntime}
            className="h-8 px-2.5"
            onClick={() => openRuntimeDialog("reset")}
          >
            {isResettingRuntime ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Clock className="size-3.5" aria-hidden="true" />
            )}
            {formatTimeUntil(vm.manualRuntime?.expiresAt)}
          </Button>
        ) : null}
        {actions.map((item) => {
          const Icon = item.icon;
          const validation = validateActionForVm(item.action, vm);
          const disabled = !validation.ok || isPending || isResettingRuntime;
          const isActive = activeAction === item.action;
          const iconOnly = iconOnlyActions.has(item.action);
          const tooltipText = validation.reason ?? item.description;

          return (
            <Tooltip key={item.action}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    size={iconOnly ? "icon" : "sm"}
                    variant={item.destructive ? "destructive" : "outline"}
                    disabled={disabled}
                    aria-label={item.label}
                    className={iconOnly ? "size-8" : "h-8 px-2.5"}
                    onClick={() => {
                      if (item.action === "start" && vm.runStrategy === "Manual") {
                        openRuntimeDialog("start");
                        return;
                      }

                      if (item.requiresConfirmation) {
                        setPendingAction(item);
                        return;
                      }

                      void runAction(item);
                    }}
                  >
                    {isActive ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Icon className="size-3.5" aria-hidden="true" />
                    )}
                    {iconOnly ? null : item.label}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{tooltipText}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <Dialog
        open={runtimeDialogMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRuntimeDialogMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {runtimeDialogMode === "start" ? "Start Manual VM" : "Reset runtime timer"}
            </DialogTitle>
            <DialogDescription>
              Target: {vm.namespace}/{vm.name}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="runtime-days">Runtime</Label>
              <span className="font-medium text-sm tabular-nums">{durationLabel(runtimeDays)}</span>
            </div>

            <input
              id="runtime-days"
              type="range"
              min="1"
              max="7"
              step="1"
              value={runtimeDays === 30 ? 7 : runtimeDays}
              disabled={runtimeDays === 30}
              onChange={(event) => {
                setRuntimeDays(Number(event.target.value) as ManualRuntimeDurationDays);
              }}
              className="w-full accent-primary disabled:opacity-50"
            />

            <div className="grid grid-cols-7 gap-1 text-center text-muted-foreground text-xs tabular-nums">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={runtimeDays === 30 ? "outline" : "default"}
                onClick={() => setRuntimeDays(runtimeDays === 30 ? 7 : runtimeDays)}
              >
                1-7 days
              </Button>
              <Button
                type="button"
                variant={runtimeDays === 30 ? "default" : "outline"}
                onClick={() => setRuntimeDays(30)}
              >
                30 days
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isPending || isResettingRuntime}
              onClick={() => setRuntimeDialogMode(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isPending || isResettingRuntime}
              onClick={submitRuntimeDialog}
            >
              {runtimeDialogMode === "start" ? "Start" : "Reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAction?.label} VM?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.description} Target: {vm.namespace}/{vm.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingAction?.destructive ? "destructive" : "default"}
              disabled={isPending}
              onClick={() => {
                if (pendingAction) {
                  void runAction(pendingAction);
                }
                setPendingAction(null);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

export { VmActionButtons as VmActionMenu };
