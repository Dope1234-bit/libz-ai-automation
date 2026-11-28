"use client";

import { useEffect, useState } from "react";
import { prospects } from "./crm";

/** Whether Google Maps prospecting is connected (null while unknown or outside Business mode). */
export function useMapsConfigured(workspaceId: string | undefined, isBusiness: boolean) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    if (!workspaceId || !isBusiness) {
      setConfigured(null);
      return;
    }
    let active = true;
    prospects
      .status(workspaceId)
      .then((s) => active && setConfigured(s.configured))
      .catch(() => active && setConfigured(null));
    return () => {
      active = false;
    };
  }, [workspaceId, isBusiness]);
  return configured;
}
