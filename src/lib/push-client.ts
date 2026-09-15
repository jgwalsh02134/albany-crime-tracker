export type PushStatusResponse =
  | { ok: true; enabled: true; publicKey: string }
  | { ok: true; enabled: false; reason?: string }
  | { ok: false; enabled?: boolean; reason?: string; error?: string };

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

// Web Push uses a URL-safe base64 VAPID public key for applicationServerKey.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function fetchPushStatus(): Promise<PushStatusResponse> {
  const r = await fetch("/api/push/status", { headers: { Accept: "application/json" } }).catch(() => null);
  if (!r) return { ok: false, error: "network" };
  try {
    return (await r.json()) as PushStatusResponse;
  } catch {
    return { ok: false, error: "invalid-json" };
  }
}

export async function ensureServiceWorkerReady(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  // Register defensively in case the page mounted before the app-level register hook.
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return await navigator.serviceWorker.ready;
}

export async function getOrCreatePushSubscription(publicKey: string): Promise<PushSubscription> {
  const reg = await ensureServiceWorkerReady();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const reg = await ensureServiceWorkerReady();
  return await reg.pushManager.getSubscription();
}

export async function getLocationOnce(): Promise<{ lat: number; lng: number; accuracyM: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracyM: typeof p.coords.accuracy === "number" ? p.coords.accuracy : 0,
        }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 60_000 },
    );
  });
}

