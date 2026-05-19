"use client";

import { Archive, Camera, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useMemo, useState, useTransition } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import type {
  ValidationResult,
  VirtualMachineBackupSummary,
  VirtualMachineDetail,
  VirtualMachineRollbackSummary,
  VirtualMachineSnapshotSummary,
} from "@/lib/kubevirt/types";
import {
  hasActiveOperation,
  validateBackupRestorePreconditions,
  validateRestorePreconditions,
  validateSnapshotName,
} from "@/lib/kubevirt/validation";
import { cn } from "@/lib/utils";

type RestoreTarget =
  | { type: "snapshot"; item: VirtualMachineSnapshotSummary }
  | { type: "backup"; item: VirtualMachineBackupSummary };

function baseEndpoint(vm: VirtualMachineDetail) {
  return `/api/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}`;
}

function defaultProtectionName(vmName: string, type: "snapshot" | "backup") {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
    .toLowerCase();
  return `${vmName}-${type}-${stamp}`.slice(0, 253);
}

function snapshotStatus(snapshot: VirtualMachineSnapshotSummary) {
  return snapshot.message ?? (snapshot.readyToUse === true ? "Ready" : snapshot.phase);
}

function backupStatus(backup: VirtualMachineBackupSummary) {
  if (backup.message) {
    return backup.message;
  }

  if (typeof backup.progress === "number" && backup.phase !== "Completed") {
    return `${backup.phase} ${backup.progress}%`;
  }

  return backup.phase;
}

function disabledRestoreMessage(
  vm: VirtualMachineDetail,
  validation: ValidationResult,
  source: "snapshot" | "backup",
) {
  if (validation.ok) {
    return undefined;
  }

  if (vm.powerState !== "offline") {
    return `Disabled while the machine is running. Stop the VM before restoring a ${source}.`;
  }

  return validation.reason;
}

function RestoreButton({
  validation,
  disabledMessage,
  isPending,
  className,
  onRestore,
}: {
  validation: ValidationResult;
  disabledMessage?: string;
  isPending: boolean;
  className?: string;
  onRestore: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex", className)}>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending || !validation.ok}
              title={disabledMessage}
              className={cn(className && "w-full")}
              onClick={onRestore}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Restore
            </Button>
          </span>
        </TooltipTrigger>
        {disabledMessage ? <TooltipContent>{disabledMessage}</TooltipContent> : null}
      </Tooltip>
    </TooltipProvider>
  );
}

function ProtectionError({ message }: { message: string }) {
  return (
    <div className="border-border border-b bg-destructive/10 px-4 py-3 text-destructive text-sm">
      {message}
    </div>
  );
}

export function SnapshotControls({ vm }: { vm: VirtualMachineDetail }) {
  const { refresh } = useRouter();
  const [snapshotName, setSnapshotName] = useState(() =>
    defaultProtectionName(vm.name, "snapshot"),
  );
  const [backupName, setBackupName] = useState(() => defaultProtectionName(vm.name, "backup"));
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [discardTarget, setDiscardTarget] = useState<VirtualMachineRollbackSummary | null>(null);
  const [isPending, startTransition] = useTransition();
  const snapshotValidation = useMemo(() => validateSnapshotName(snapshotName), [snapshotName]);
  const backupValidation = useMemo(() => validateSnapshotName(backupName), [backupName]);
  const operationInProgress = hasActiveOperation(vm);
  const blockedReason = vm.protectionError
    ? vm.protectionError
    : operationInProgress
      ? "A VM storage operation is already in progress."
      : undefined;

  function submitJson(endpoint: string, body: unknown, fallback: string) {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? fallback);
      }
    });
  }

  function createSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshotValidation.ok) {
      toast.error(snapshotValidation.reason);
      return;
    }

    if (blockedReason) {
      toast.error(blockedReason);
      return;
    }

    startTransition(async () => {
      try {
        await submitJson(
          `${baseEndpoint(vm)}/snapshots`,
          { name: snapshotName },
          "Snapshot creation failed.",
        );
        toast.success(`Snapshot ${snapshotName} created.`);
        setSnapshotName(defaultProtectionName(vm.name, "snapshot"));
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Snapshot creation failed.");
      }
    });
  }

  function createBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!backupValidation.ok) {
      toast.error(backupValidation.reason);
      return;
    }

    if (blockedReason) {
      toast.error(blockedReason);
      return;
    }

    startTransition(async () => {
      try {
        await submitJson(
          `${baseEndpoint(vm)}/backups`,
          { name: backupName, backupMode: "incremental" },
          "Backup creation failed.",
        );
        toast.success(`Backup ${backupName} created.`);
        setBackupName(defaultProtectionName(vm.name, "backup"));
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Backup creation failed.");
      }
    });
  }

  function restoreProtection(target: RestoreTarget) {
    const validation =
      target.type === "snapshot"
        ? validateRestorePreconditions(vm, target.item)
        : validateBackupRestorePreconditions(vm, target.item);

    if (!validation.ok) {
      toast.error(validation.reason);
      return;
    }

    startTransition(async () => {
      try {
        await submitJson(
          `${baseEndpoint(vm)}/restores`,
          target.type === "snapshot"
            ? { sourceType: "snapshot", snapshotName: target.item.name }
            : { sourceType: "backup", backupName: target.item.name },
          "Restore failed.",
        );
        toast.success(`Restore submitted from ${target.item.name}.`);
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Restore failed.");
      }
    });
  }

  function discardRollback(rollback: VirtualMachineRollbackSummary) {
    startTransition(async () => {
      try {
        const response = await fetch(
          `${baseEndpoint(vm)}/rollbacks/${encodeURIComponent(rollback.pvName)}`,
          { method: "DELETE" },
        );

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(payload?.error?.message ?? "Rollback discard failed.");
          return;
        }

        toast.success(`Rollback ${rollback.pvName} discarded.`);
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Rollback discard failed.");
      }
    });
  }

  function forceClearOperation() {
    startTransition(async () => {
      try {
        const response = await fetch(`${baseEndpoint(vm)}/operations`, { method: "DELETE" });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(payload?.error?.message ?? "Operation clear failed.");
          return;
        }

        toast.success("VM operation annotation cleared.");
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Operation clear failed.");
      }
    });
  }

  return (
    <>
      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-2 border-border border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-medium text-sm">Rootdisk protection</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Restores replace only the Longhorn rootdisk. TPM and EFI state PVCs are left in place.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {operationInProgress ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={forceClearOperation}
              >
                Clear operation
              </Button>
            ) : null}
            {vm.rootDisk ? (
              <Badge variant="outline" className="w-fit rounded-md">
                {vm.rootDisk.volumeName}
              </Badge>
            ) : null}
          </div>
        </div>

        {vm.protectionError ? <ProtectionError message={vm.protectionError} /> : null}

        <div className="grid gap-0 lg:grid-cols-2">
          <form
            onSubmit={createSnapshot}
            className="grid gap-3 border-border border-b p-4 lg:border-r"
          >
            <div className="space-y-1">
              <Label htmlFor="snapshot-name">Snapshot name</Label>
              <Input
                id="snapshot-name"
                value={snapshotName}
                onChange={(event) => setSnapshotName(event.target.value)}
                aria-invalid={!snapshotValidation.ok}
              />
              {!snapshotValidation.ok ? (
                <p className="text-destructive text-xs">{snapshotValidation.reason}</p>
              ) : null}
            </div>
            <Button
              type="submit"
              className="w-fit"
              disabled={isPending || !snapshotValidation.ok || Boolean(blockedReason)}
              title={blockedReason}
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Camera className="size-4" aria-hidden="true" />
              )}
              Snapshot
            </Button>
          </form>

          <form onSubmit={createBackup} className="grid gap-3 border-border border-b p-4">
            <div className="space-y-1">
              <Label htmlFor="backup-name">Backup name</Label>
              <Input
                id="backup-name"
                value={backupName}
                onChange={(event) => setBackupName(event.target.value)}
                aria-invalid={!backupValidation.ok}
              />
              {!backupValidation.ok ? (
                <p className="text-destructive text-xs">{backupValidation.reason}</p>
              ) : null}
            </div>
            <Button
              type="submit"
              className="w-fit"
              disabled={isPending || !backupValidation.ok || Boolean(blockedReason)}
              title={blockedReason}
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Archive className="size-4" aria-hidden="true" />
              )}
              Backup
            </Button>
          </form>
        </div>
      </section>

      <ProtectionTable
        title="Fast snapshots"
        emptyText="No rootdisk snapshots exist for this VM."
        items={vm.snapshots}
        statusFor={snapshotStatus}
        restoreFor={(snapshot) => {
          const validation = validateRestorePreconditions(vm, snapshot);
          return (
            <RestoreButton
              validation={validation}
              disabledMessage={disabledRestoreMessage(vm, validation, "snapshot")}
              isPending={isPending}
              onRestore={() => setRestoreTarget({ type: "snapshot", item: snapshot })}
            />
          );
        }}
      />

      <ProtectionTable
        title="Longhorn backups"
        emptyText="No rootdisk backups exist for this VM."
        items={vm.backups}
        statusFor={backupStatus}
        restoreFor={(backup) => {
          const validation = validateBackupRestorePreconditions(vm, backup);
          return (
            <RestoreButton
              validation={validation}
              disabledMessage={disabledRestoreMessage(vm, validation, "backup")}
              isPending={isPending}
              onRestore={() => setRestoreTarget({ type: "backup", item: backup })}
            />
          );
        }}
      />

      {vm.rollbacks.length > 0 ? (
        <section className="rounded-lg border border-border bg-card">
          <div className="border-border border-b px-4 py-3">
            <h2 className="font-medium text-sm">Rollback storage</h2>
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PV</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-28 text-right">Discard</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vm.rollbacks.map((rollback) => (
                  <TableRow key={rollback.pvName}>
                    <TableCell className="font-medium">{rollback.pvName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {rollback.volumeName ?? "Unknown"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDateTime(rollback.expiresAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => setDiscardTarget(rollback)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        Discard
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore rootdisk?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace only {vm.namespace}/{vm.name} rootdisk from{" "}
              {restoreTarget?.item.name}. The VM must remain stopped; TPM and EFI state PVCs are
              preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() => {
                if (restoreTarget) {
                  restoreProtection(restoreTarget);
                }
                setRestoreTarget(null);
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={discardTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDiscardTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard rollback storage?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes {discardTarget?.pvName} and its old Longhorn rootdisk volume.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isPending}
              onClick={() => {
                if (discardTarget) {
                  discardRollback(discardTarget);
                }
                setDiscardTarget(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProtectionTable<T extends { name: string; createdAt?: string }>({
  title,
  emptyText,
  items,
  statusFor,
  restoreFor,
}: {
  title: string;
  emptyText: string;
  items: T[];
  statusFor: (item: T) => string;
  restoreFor: (item: T) => ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-border border-b px-4 py-3">
        <h2 className="font-medium text-sm">{title}</h2>
      </div>
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-28 text-right">Restore</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.name}>
                <TableCell className="font-medium">{item.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{statusFor(item)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDateTime(item.createdAt)}
                </TableCell>
                <TableCell className="text-right">{restoreFor(item)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y divide-border md:hidden">
        {items.map((item) => (
          <div key={item.name} className="space-y-3 p-4">
            <div className="min-w-0">
              <p className="break-words font-medium text-sm">{item.name}</p>
              <p className="mt-1 text-muted-foreground text-xs">
                {statusFor(item)} - {formatDateTime(item.createdAt)}
              </p>
            </div>
            {restoreFor(item)}
          </div>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-10 text-center text-muted-foreground text-sm">{emptyText}</div>
      ) : null}
    </section>
  );
}
