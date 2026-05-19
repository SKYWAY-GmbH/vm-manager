"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const DEFAULT_INTERVAL_MS = 1_000;

export function AutoRefresh({ intervalMs = DEFAULT_INTERVAL_MS }: { intervalMs?: number }) {
  const { refresh } = useRouter();

  useEffect(() => {
    const interval = window.setInterval(() => {
      refresh();
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [intervalMs, refresh]);

  return null;
}
