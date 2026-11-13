import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { toastDbError } from "@/lib/db-errors";
import type { JobRoom } from "@/lib/job-rooms";
import { listQueue, newId, subscribe, writeOrQueue } from "@/lib/offline-queue";
import { applyRoomCaptureOp, fetchRoomCapture } from "@/lib/room-capture";
import { applyHeldOps, type RoomCaptureOp } from "@/lib/room-capture-ops";

type Held = { id: string; op: RoomCaptureOp };

/** Said once per burst, not once per field — a crew in a basement measures a lot of rooms. */
const HELD_TOAST = "Held on this device — it saves when you have signal.";

/**
 * Field capture's state for a job: its doors, windows and cabinet runs, the
 * job's rooms with any held measurements laid over them, and `run` — the one
 * way a capture change is saved.
 *
 * Every change goes through the offline queue (`writeOrQueue`), the same path
 * as a drying reading or a placed dehu: tried at once, and held on the device
 * when there is no signal, to drain when there is. Crews measure in
 * basements. A held change is shown straight away — the door is in the room
 * and in the takeoffs — and is dropped from the overlay only once the queue no
 * longer holds it and the next read has the server's copy.
 */
export function useRoomCapture(
  jobId: string,
  rooms: JobRoom[],
  opts: {
    /**
     * Ops that were held on this device and have now reached the server. A
     * copied layout makes rooms, and rooms need photo folders — which can
     * only be made once the rooms exist, so the tab is told here.
     */
    onLanded?: (ops: RoomCaptureOp[]) => void;
  } = {},
) {
  const qc = useQueryClient();
  const onLanded = useRef(opts.onLanded);
  onLanded.current = opts.onLanded;
  const captureQ = useQuery({
    queryKey: ["job-room-capture", jobId],
    queryFn: () => fetchRoomCapture(jobId),
  });
  const [held, setHeld] = useState<Held[]>([]);
  /** Writes whose first attempt has not returned yet — not "gone" from the queue, just not in it yet. */
  const inflight = useRef(new Set<string>());

  const refresh = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["job-rooms", jobId] }),
        qc.invalidateQueries({ queryKey: ["job-room-capture", jobId] }),
      ]),
    [qc, jobId],
  );

  // Watch the queue while anything is held: when a held change drains (or is
  // refused and parked in the sync list with its reason), re-read and let the
  // server's copy take over.
  useEffect(() => {
    if (!held.length) return;
    let alive = true;
    const check = async () => {
      const items = await listQueue();
      const waiting = new Set(items.filter((i) => i.status !== "rejected").map((i) => i.id));
      const gone = held
        .filter((h) => !inflight.current.has(h.id) && !waiting.has(h.id))
        .map((h) => h.id);
      if (!alive || !gone.length) return;
      await refresh();
      if (!alive) return;
      setHeld((cur) => cur.filter((h) => !gone.includes(h.id)));
      onLanded.current?.(held.filter((h) => gone.includes(h.id)).map((h) => h.op));
    };
    const unsubscribe = subscribe(() => void check());
    void check();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [held, refresh]);

  const run = useCallback(
    /** "landed" reached the server now; "held" is on this device; "refused" was said in a toast. */
    async (op: RoomCaptureOp, label: string): Promise<"landed" | "held" | "refused"> => {
      const id = newId();
      inflight.current.add(id);
      setHeld((cur) => [...cur, { id, op }]);
      try {
        const res = await writeOrQueue({
          kind: "room_capture",
          id,
          payload: op as unknown as Record<string, unknown>,
          label,
          write: () => applyRoomCaptureOp(op),
        });
        inflight.current.delete(id);
        if (res.queued) {
          toast.warning(HELD_TOAST, { id: "room-capture-held" });
          return "held";
        }
        await refresh();
        setHeld((cur) => cur.filter((h) => h.id !== id));
        return "landed";
      } catch (e) {
        // A refusal the server will repeat (no permission, a value the
        // database will not take) is said now, not buried in a list later.
        inflight.current.delete(id);
        setHeld((cur) => cur.filter((h) => h.id !== id));
        toastDbError(e, { action: label });
        return "refused";
      }
    },
    [refresh],
  );

  const merged = useMemo(
    () =>
      applyHeldOps(
        {
          rooms,
          openings: captureQ.data?.openings ?? [],
          cabinets: captureQ.data?.cabinets ?? [],
        },
        held.map((h) => h.op),
      ),
    [rooms, captureQ.data, held],
  );

  return {
    ...merged,
    /** False until the tables exist (migration 20261006140000) — the sections say so instead. */
    partsAvailable: captureQ.isSuccess && captureQ.data != null,
    partsLoading: captureQ.isLoading,
    partsError: captureQ.isError,
    heldCount: held.length,
    run,
  };
}
