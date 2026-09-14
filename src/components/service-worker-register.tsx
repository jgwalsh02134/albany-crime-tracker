import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);

  return null;
}

