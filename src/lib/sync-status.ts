/**
 * One view of everything waiting to reach the server: the small-payload queue
 * (outcomes, declines, arrivals, notes, exposure leads) and the photo queue,
 * which uploads at full resolution and lives in its own IndexedDB store.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  drain,
  listQueue,
  removeItem,
  retryItem,
  subscribe,
  type QueuedItem,
} from "@/lib/offline-queue";
import {
  drainQueue as drainPhotoQueue,
  listQueue as listPhotoQueue,
  dequeuePhoto,
  reclaimOnStartup,
  reclaimStalledUploads,
  retryPhoto as retryQueuedPhoto,
  subscribeUploads,
  uploadProgressSnapshot,
  type QueuedPhoto,
} from "@/lib/photos";

/**
 * Items thrown away by hand since the queue last emptied. The "it landed"
 * message below is inferred from the queue reaching zero — the queue module
 * reports no per-item outcome — so a discard has to be subtracted or the app
 * would claim it uploaded work the user deliberately binned.
 */
let discarded = 0;

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const set = () => setOnline(navigator.onLine);
    set();
    window.addEventListener("online", set);
    window.addEventListener("offline", set);
    return () => {
      window.removeEventListener("online", set);
      window.removeEventListener("offline", set);
    };
  }, []);
  return online;
}

export type SyncState = {
  items: QueuedItem[];
  photos: QueuedPhoto[];
  /**
   * Live upload progress by photo id, 0–1, for photos this page has a request
   * open for. A photo missing from here is not being uploaded right now,
   * whatever its stored status says — which is the whole point: the sheet used
   * to draw a bar at a hard-coded 60% for anything marked "uploading", so an
   * abandoned attempt looked identical to a working one.
   */
  photoProgress: Record<string, number>;
  count: number;
  rejected: number;
  online: boolean;
  refresh: () => void;
  syncNow: () => Promise<void>;
  retryOne: (id: string) => Promise<void>;
  retryPhoto: (photo: QueuedPhoto) => Promise<void>;
  discard: (id: string) => Promise<void>;
  discardPhoto: (id: string) => Promise<void>;
};

export function useSyncQueue(): SyncState {
  const online = useOnline();
  const [items, setItems] = useState<QueuedItem[]>([]);
  const [photos, setPhotos] = useState<QueuedPhoto[]>([]);
  const [photoProgress, setPhotoProgress] = useState<Record<string, number>>({});

  const refresh = useCallback(() => {
    void listQueue().then(setItems);
    void listPhotoQueue().then(setPhotos);
    setPhotoProgress(uploadProgressSnapshot());
  }, []);

  useEffect(() => {
    refresh();
    const off = subscribe(refresh);
    // Bytes move far faster than the three-second poll, so the bar has its own
    // subscription; without it a real percentage would still look like a
    // staircase and the crew would be back to not trusting it.
    const offUploads = subscribeUploads(() => setPhotoProgress(uploadProgressSnapshot()));
    const t = window.setInterval(refresh, 3000);
    return () => {
      off();
      offUploads();
      window.clearInterval(t);
    };
  }, [refresh]);

  // Photos flush alongside the rest the moment the connection returns.
  useEffect(() => {
    if (!online) return;
    void (async () => {
      /*
       * Before anything else: an app that was killed mid-upload sorts itself
       * out here. Nothing in this page is in flight yet, so anything still
       * marked "uploading" is from a page that is gone, and it goes back in
       * the queue in time for the drain two lines down. Mark's three photos
       * needed him to tap Retry on each one; they should just be gone.
       */
      await reclaimOnStartup().catch(() => 0);
      const queued = await listPhotoQueue();
      const projects = [...new Set(queued.map((p) => p.projectId))];
      for (const projectId of projects) await drainPhotoQueue(projectId);
      refresh();
    })();
  }, [online, refresh]);

  const syncNow = useCallback(async () => {
    await drain({ includeRejected: true });
    // "Upload all now" means all of it, including what gave up.
    await reclaimStalledUploads({ staleMs: 0 }).catch(() => 0);
    const queued = await listPhotoQueue();
    for (const projectId of [...new Set(queued.map((p) => p.projectId))]) {
      await drainPhotoQueue(projectId, 3, { includeRejected: true });
    }
    refresh();
  }, [refresh]);

  return {
    items,
    photos,
    photoProgress,
    count: items.length + photos.length,
    // A photo that has given up needs attention exactly as much as a rejected
    // write does, and the top-bar chip said "Online" while three sat there.
    rejected:
      items.filter((i) => i.status === "rejected").length +
      photos.filter((p) => p.status === "rejected").length,
    online,
    refresh,
    syncNow,
    retryOne: async (id) => {
      await retryItem(id);
      refresh();
    },
    retryPhoto: async (photo) => {
      await retryQueuedPhoto(photo.id).catch(() => {});
      refresh();
    },
    discard: async (id) => {
      discarded += 1;
      await removeItem(id);
      refresh();
    },
    discardPhoto: async (id) => {
      discarded += 1;
      await dequeuePhoto(id);
      refresh();
    },
  };
}

/**
 * What is still on this phone for one job, and how to push it.
 *
 * The album counts rows the server has. Mark uploaded 182 photos to a job and
 * the album read 179, with nothing on the page saying where the other three
 * were — they were in a sheet in the top bar he had no reason to open. An
 * insurance claim short three documentation photos is short money, so the
 * shortfall has to appear where the crew is actually looking.
 */
export function usePendingPhotoUploads(projectId: string | null): {
  pending: QueuedPhoto[];
  stuck: number;
  retryAll: () => Promise<void>;
} {
  const [pending, setPending] = useState<QueuedPhoto[]>([]);

  const refresh = useCallback(() => {
    if (!projectId) {
      setPending([]);
      return;
    }
    void listPhotoQueue(projectId).then(setPending);
  }, [projectId]);

  useEffect(() => {
    refresh();
    const offUploads = subscribeUploads(refresh);
    const t = window.setInterval(refresh, 3000);
    return () => {
      offUploads();
      window.clearInterval(t);
    };
  }, [refresh]);

  const retryAll = useCallback(async () => {
    if (!projectId) return;
    await reclaimStalledUploads({ staleMs: 0 }).catch(() => 0);
    await drainPhotoQueue(projectId, 3, { includeRejected: true });
    refresh();
  }, [projectId, refresh]);

  return {
    pending,
    stuck: pending.filter((p) => p.status === "error" || p.status === "rejected").length,
    retryAll,
  };
}

/**
 * Connection and queue changes, said out loud.
 *
 * The queue was silent at both ends. Going offline was only discoverable by
 * saving something, and work leaving the pending list looked identical to work
 * being lost — a count going from 3 to nothing with no word about where it
 * went. Reassurance that it landed is the whole point of holding it.
 *
 * Mount once, in the shell.
 */
export function useSyncAnnouncements({ online, count }: { online: boolean; count: number }) {
  const wasOnline = useRef<boolean | null>(null);
  const peak = useRef(0);

  useEffect(() => {
    // First pass is the initial state, not a change to announce.
    if (wasOnline.current === null) {
      wasOnline.current = online;
      return;
    }
    if (wasOnline.current === online) return;
    wasOnline.current = online;
    if (!online) {
      toast.warning("You're offline", {
        description: "Anything you save is kept on this phone and uploads when you have signal.",
      });
    } else if (peak.current === 0) {
      toast.success("Back online");
    }
  }, [online]);

  useEffect(() => {
    if (count > peak.current) {
      peak.current = count;
      return;
    }
    if (count > 0 || peak.current === 0) return;
    const landed = peak.current - discarded;
    peak.current = 0;
    discarded = 0;
    if (!online || landed <= 0) return;
    toast.success(`${landed} item${landed === 1 ? "" : "s"} uploaded`, {
      description: "Everything you captured on this phone has reached the server.",
    });
  }, [count, online]);
}
