import { Boxes, GitBranch, ServerCog } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="border-border border-b bg-sidebar md:w-64 md:border-r md:border-b-0">
          <div className="flex h-16 items-center gap-3 px-5 md:h-20">
            <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
              <ServerCog className="size-5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <Link href="/" className="block truncate font-semibold text-sm">
                SKYWAY VM Manager
              </Link>
              <p className="truncate text-muted-foreground text-xs">KubeVirt control surface</p>
            </div>
          </div>
          <nav className="flex gap-1 px-3 pb-3 md:block md:space-y-1">
            <Link
              href="/"
              className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-accent"
            >
              <Boxes className="size-4" aria-hidden="true" />
              Virtual machines
            </Link>
            <a
              href="https://github.com/SKYWAY-GmbH/vm-manager"
              className="flex h-9 items-center gap-2 rounded-lg px-3 text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
            >
              <GitBranch className="size-4" aria-hidden="true" />
              Repository
            </a>
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
