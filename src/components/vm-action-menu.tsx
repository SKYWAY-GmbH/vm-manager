"use client";

import { Loader2, MoreHorizontal, Play, Power, RotateCw, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { VirtualMachineSummary, VmAction } from "@/lib/kubevirt/types";
import { validateActionForVm } from "@/lib/kubevirt/validation";

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
    label: "Graceful stop",
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
    label: "Force stop",
    description: "Cut power immediately. Unsaved guest data can be lost.",
    icon: Power,
    destructive: true,
    requiresConfirmation: true,
  },
];

function actionEndpoint(vm: VirtualMachineSummary) {
  return `/api/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}/actions`;
}

export function VmActionMenu({ vm }: { vm: VirtualMachineSummary }) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<(typeof actions)[number] | null>(null);
  const [isPending, startTransition] = useTransition();

  async function runAction(nextAction: (typeof actions)[number]) {
    const validation = validateActionForVm(nextAction.action, vm);
    if (!validation.ok) {
      toast.error(validation.reason);
      return;
    }

    startTransition(async () => {
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
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "VM action failed.");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline" aria-label={`Actions for ${vm.name}`}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <MoreHorizontal className="size-4" aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {actions.map((item, index) => {
            const Icon = item.icon;
            const validation = validateActionForVm(item.action, vm);
            return (
              <Fragment key={item.action}>
                {index === 1 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  disabled={!validation.ok || isPending}
                  variant={item.destructive ? "destructive" : "default"}
                  onClick={() => {
                    if (item.requiresConfirmation) {
                      setPendingAction(item);
                      return;
                    }

                    void runAction(item);
                  }}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {item.label}
                </DropdownMenuItem>
              </Fragment>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

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
