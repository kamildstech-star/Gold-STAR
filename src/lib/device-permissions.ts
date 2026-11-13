import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Device permissions for chasers.
 *
 * We never fire a browser permission prompt cold: the explainer screen runs
 * first, and only an explicit "Continue" tap triggers the system dialog.
 * State is recorded per user + device so the explainer shows once, and so
 * managers can see who is denied.
 */

export type PermState = "unknown" | "granted" | "denied" | "prompt";

export type DevicePerms = {
  primed: boolean;
  location: PermState;
  notifications: PermState;
};

export type Platform = "ios-safari" | "android-chrome" | "desktop";

const DEVICE_KEY = "gs.device-id";

export function deviceId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (iOS) return "ios-safari";
  if (/Android/.test(ua)) return "android-chrome";
  return "desktop";
}

/** Honest about what the platform actually supports. */
export const REENABLE_STEPS: Record<
  Platform,
  { title: string; steps: string[]; deepLink?: string }
> = {
  "ios-safari": {
    title: "iPhone / iPad — Safari",
    steps: [
      "Open the iOS Settings app (Safari can't link to it).",
      "Tap Apps → Safari → Location, and choose “Ask” or “Allow”.",
      "Back in Settings, tap Privacy & Security → Location Services and make sure Safari Websites is allowed.",
      "Return here and tap “Try again”.",
    ],
  },
  "android-chrome": {
    title: "Android — Chrome",
    steps: [
      "Tap the lock or tune icon beside the address bar.",
      "Tap Permissions and set Location and Notifications to Allow.",
      "Reload this page, then tap “Try again”.",
    ],
    deepLink: "app-settings:",
  },
  desktop: {
    title: "Desktop browser",
    steps: [
      "Click the lock / tune icon at the left of the address bar.",
      "Set Location and Notifications to Allow.",
      "Reload the page, then click “Try again”.",
    ],
  },
};

export async function readBrowserPerms(): Promise<{
  location: PermState;
  notifications: PermState;
}> {
  let location: PermState = "unknown";
  let notifications: PermState = "unknown";
  try {
    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      const s = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      location = s.state as PermState;
    }
  } catch {
    /* not supported */
  }
  if (typeof Notification !== "undefined") {
    notifications =
      Notification.permission === "default" ? "prompt" : (Notification.permission as PermState);
  }
  return { location, notifications };
}

/** Fires the real system dialogs, in order. Only call from a user gesture. */
export async function requestBrowserPerms(): Promise<{
  location: PermState;
  notifications: PermState;
}> {
  let location: PermState = "unknown";
  if (typeof navigator !== "undefined" && navigator.geolocation) {
    location = await new Promise<PermState>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve("granted"),
        (err) => resolve(err.code === err.PERMISSION_DENIED ? "denied" : "prompt"),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });
  }

  let notifications: PermState = "unknown";
  if (typeof Notification !== "undefined") {
    try {
      const r = await Notification.requestPermission();
      notifications = r === "default" ? "prompt" : (r as PermState);
    } catch {
      notifications = "unknown";
    }
  }
  return { location, notifications };
}

export function useDevicePermissions(userId: string | null) {
  const [state, setState] = useState<DevicePerms>({
    primed: true, // assume primed until loaded, so the screen never flashes
    location: "unknown",
    notifications: "unknown",
  });
  const [loading, setLoading] = useState(true);

  const sync = useCallback(
    async (perms: { location: PermState; notifications: PermState }, primed: boolean) => {
      setState({ primed, ...perms });
      if (!userId) return;
      const now = new Date().toISOString();
      await supabase.from("user_device_permissions").upsert(
        {
          user_id: userId,
          device_id: deviceId(),
          platform: detectPlatform(),
          user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 400) : null,
          primed_at: primed ? now : null,
          location_state: perms.location,
          notifications_state: perms.notifications,
          location_denied_at: perms.location === "denied" ? now : null,
          notifications_denied_at: perms.notifications === "denied" ? now : null,
          last_seen_at: now,
        },
        { onConflict: "user_id,device_id" },
      );
    },
    [userId],
  );

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const browser = await readBrowserPerms();
      const { data } = await supabase
        .from("user_device_permissions")
        .select("primed_at")
        .eq("user_id", userId)
        .eq("device_id", deviceId())
        .maybeSingle();
      if (cancelled) return;
      const primed = Boolean(data?.primed_at) || browser.location === "granted";
      setState({ primed, ...browser });
      setLoading(false);
      // Record current state without ever prompting on launch.
      void sync(browser, primed);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, sync]);

  /** Explicit user action only. */
  const prime = useCallback(async () => {
    const perms = await requestBrowserPerms();
    await sync(perms, true);
    return perms;
  }, [sync]);

  /** Records that the explainer was seen even if the user skipped. */
  const dismissExplainer = useCallback(async () => {
    const perms = await readBrowserPerms();
    await sync(perms, true);
  }, [sync]);

  const degraded =
    state.location === "denied" || state.notifications === "denied"
      ? ([
          state.location === "denied"
            ? "Arrival logging, distance and ETA to incidents, and routing are off."
            : null,
          state.notifications === "denied" ? "New fire alerts won't reach this device." : null,
        ].filter(Boolean) as string[])
      : [];

  return { ...state, loading, prime, dismissExplainer, degraded, platform: detectPlatform() };
}
