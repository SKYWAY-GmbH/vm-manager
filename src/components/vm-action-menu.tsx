"use client";

import { Loader2, Play, Power, RotateCw, Square } from "lucide-react";
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
import type { VirtualMachineSummary, VmAction } from "@/lib/kubevirt/types";
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

function actionEndpoint(vm: VirtualMachineSummary) {
  return `/api/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}/actions`;
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
  const [activeAction, setActiveAction] = useState<VmAction | null>(null);
  const [isPending, startTransition] = useTransition();

  async function runAction(nextAction: (typeof actions)[number]) {
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
          body: JSON.stringify({ action: nextAction.action }),
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

  return (
    <>
      <div className={cn("flex flex-wrap justify-end gap-1.5", className)}>
        {actions.map((item) => {
          const Icon = item.icon;
          const validation = validateActionForVm(item.action, vm);
          const disabled = !validation.ok || isPending;
          const isActive = activeAction === item.action;

          return (
            <Button
              key={item.action}
              size="sm"
              variant={item.destructive ? "destructive" : "outline"}
              disabled={disabled}
              title={validation.reason}
              className="h-8 px-2.5"
              onClick={() => {
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
              {item.label}
            </Button>
          );
        })}
      </div>

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
    </>
  );
}

export { VmActionButtons as VmActionMenu };
