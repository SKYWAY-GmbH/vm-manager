import { ServerCog } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-border border-b bg-card/70">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-background">
            <ServerCog className="size-4 text-primary" aria-hidden="true" />
          </div>
          <Link href="/" className="font-semibold text-sm">
            SKYWAY VM Manager
          </Link>
        </div>
      </div>
      <div className="min-h-[calc(100vh-3.5rem)]">
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
