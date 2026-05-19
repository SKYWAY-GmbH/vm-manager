"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

const DEFAULT_INTERVAL_MS = 1_000;

export function AutoRefresh({ intervalMs = DEFAULT_INTERVAL_MS }: { intervalMs?: number }) {
  const { refresh } = useRouter();
  const [, setHeartbeat] = useState(0);
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(isPending);
  const refreshNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);

  const refreshNow = useCallback(() => {
    setHeartbeat((value) => (value + 1) % Number.MAX_SAFE_INTEGER);

    if (pendingRef.current) {
      return;
    }

    startTransition(() => {
      refresh();
    });
  }, [refresh]);

  useEffect(() => {
    refreshNowRef.current = refreshNow;
  }, [refreshNow]);

  useEffect(() => {
    const refreshFromRef = () => {
      refreshNowRef.current();
    };

    const interval = window.setInterval(() => {
      refreshFromRef();
    }, intervalMs);

    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        refreshFromRef();
      }
    };

    window.addEventListener("focus", refreshFromRef);
    window.addEventListener("pageshow", refreshFromRef);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    refreshFromRef();

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshFromRef);
      window.removeEventListener("pageshow", refreshFromRef);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [intervalMs]);

  return null;
}
