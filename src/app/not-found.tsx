import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
        <h1 className="font-semibold text-2xl">VM not found</h1>
        <p className="text-muted-foreground text-sm">
          The requested virtual machine is not visible to this service account.
        </p>
        <Button asChild className="w-fit">
          <Link href="/">Back to inventory</Link>
        </Button>
      </div>
    </AppShell>
  );
}
