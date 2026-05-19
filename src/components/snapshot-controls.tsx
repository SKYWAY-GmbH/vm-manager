"use client";

import { Camera, Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { SnapshotReadyBadge } from "@/components/status-badge";
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
import { formatDateTime } from "@/lib/format";
import type { VirtualMachineDetail, VirtualMachineSnapshotSummary } from "@/lib/kubevirt/types";
import { validateRestorePreconditions, validateSnapshotName } from "@/lib/kubevirt/validation";

function baseEndpoint(vm: VirtualMachineDetail) {
  return `/api/vms/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}`;
}

function defaultSnapshotName(vmName: string) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
    .toLowerCase();
  return `${vmName}-snapshot-${stamp}`.slice(0, 253);
}

export function SnapshotControls({ vm }: { vm: VirtualMachineDetail }) {
  const router = useRouter();
  const [snapshotName, setSnapshotName] = useState(() => defaultSnapshotName(vm.name));
  const [restoreTarget, setRestoreTarget] = useState<VirtualMachineSnapshotSummary | null>(null);
  const [isPending, startTransition] = useTransition();
  const snapshotValidation = useMemo(() => validateSnapshotName(snapshotName), [snapshotName]);

  function createSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshotValidation.ok) {
      toast.error(snapshotValidation.reason);
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${baseEndpoint(vm)}/snapshots`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: snapshotName }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(payload?.error?.message ?? "Snapshot creation failed.");
          return;
        }

        toast.success(`Snapshot ${snapshotName} created.`);
        setSnapshotName(defaultSnapshotName(vm.name));
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Snapshot creation failed.");
      }
    });
  }

  function restoreSnapshot(snapshot: VirtualMachineSnapshotSummary) {
    const validation = validateRestorePreconditions(vm, snapshot);
    if (!validation.ok) {
      toast.error(validation.reason);
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${baseEndpoint(vm)}/restores`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ snapshotName: snapshot.name }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(payload?.error?.message ?? "Snapshot restore failed.");
          return;
        }

        toast.success(`Restore submitted from ${snapshot.name}.`);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Snapshot restore failed.");
      }
    });
  }

  return (
    <>
      <section className="rounded-lg border border-border bg-card">
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-sm">Snapshots</h2>
        </div>
        <form
          onSubmit={createSnapshot}
          className="grid gap-3 border-border border-b p-4 md:grid-cols-[1fr_auto]"
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
          <Button type="submit" className="self-end" disabled={isPending || !snapshotValidation.ok}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Camera className="size-4" aria-hidden="true" />
            )}
            Create
          </Button>
        </form>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Ready</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-28 text-right">Restore</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vm.snapshots.map((snapshot) => {
                const validation = validateRestorePreconditions(vm, snapshot);
                return (
                  <TableRow key={snapshot.name}>
                    <TableCell className="font-medium">{snapshot.name}</TableCell>
                    <TableCell>
                      <SnapshotReadyBadge ready={snapshot.readyToUse} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {snapshot.message ?? snapshot.phase}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDateTime(snapshot.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending || !validation.ok}
                        onClick={() => setRestoreTarget(snapshot)}
                      >
                        <RotateCcw className="size-4" aria-hidden="true" />
                        Apply
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {vm.snapshots.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground text-sm">
            No snapshots exist for this VM.
          </div>
        ) : null}
      </section>

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
            <AlertDialogTitle>Apply snapshot?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restore {vm.namespace}/{vm.name} from {restoreTarget?.name}. The VM must
              remain stopped while the restore runs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() => {
                if (restoreTarget) {
                  restoreSnapshot(restoreTarget);
                }
                setRestoreTarget(null);
              }}
            >
              Apply snapshot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
