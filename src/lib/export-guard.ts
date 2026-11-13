import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { canExport, type AppRole } from "@/lib/roles";
import { useCan } from "@/lib/permissions";
import { toast } from "sonner";

/**
 * Export is a leak surface, not a convenience. Reps never get files;
 * the `data.export` capability does, and every file taken is recorded.
 *
 * The database is the real gate — `log_export` raises if the caller is not
 * authorised — so a UI bypass produces an audit row failure, not a silent
 * download.
 */
/**
 * What an office manager may export as well as the Sales Head and Owner.
 *
 * Mark, 6 Oct, on the Equipment register's new export: office managers get
 * it too. Only this register — tags, types, office, serial, make, model and
 * notes, no money — not exports in general, which stay a leak surface.
 *
 * `log_export` in the database checks the same entity and the same roles
 * (20261006120000_export_gate_equipment_managers.sql); the button showing is
 * a convenience, the database is the gate. Change both together.
 */
export const MANAGER_EXPORTABLE_ENTITIES: readonly string[] = ["equipment"];

/** Office managers, the legacy `office` alias of the same job, and regional managers. */
export const EXPORT_MANAGER_ROLES: readonly AppRole[] = ["location_manager", "office", "regional"];

export function managerMayExport(roles: readonly AppRole[], entity: string | undefined): boolean {
  return (
    entity != null &&
    MANAGER_EXPORTABLE_ENTITIES.includes(entity) &&
    roles.some((r) => EXPORT_MANAGER_ROLES.includes(r))
  );
}

export function useExportGate(opts: { entity?: string } = {}) {
  const app = useAppContext();
  const canExportCap = useCan("data.export");
  const permitted =
    canExportCap || canExport(app.roles) || managerMayExport(app.roles, opts.entity);
  const allowed = permitted && !app.isImpersonating;

  const reason = !permitted
    ? "Exports and downloads are limited to the Sales Head and Owner. You can work with this data in the system."
    : app.isImpersonating
      ? "Exports are disabled while View As is active."
      : null;

  /**
   * Records the export, then runs the download. If recording fails the file
   * is never produced — an unlogged export is the thing we are preventing.
   */
  async function runExport(opts: {
    surface: string;
    entity: string;
    recordCount: number;
    format?: string;
    filters?: Record<string, unknown>;
    download: () => void;
  }): Promise<boolean> {
    if (!allowed) {
      toast.error("Export not permitted", { description: reason ?? undefined });
      return false;
    }
    const { error } = await supabase.rpc("log_export", {
      _surface: opts.surface,
      _entity: opts.entity,
      _record_count: opts.recordCount,
      _format: opts.format ?? "csv",
      _filters: (opts.filters ?? {}) as never,
    });
    if (error) {
      toast.error("Export blocked", { description: error.message });
      return false;
    }
    opts.download();
    if (opts.recordCount >= 500) {
      toast.info("Large export logged", {
        description: `${opts.recordCount} records. The Owner has been notified.`,
      });
    }
    return true;
  }

  return { allowed, reason, runExport };
}

export type ExportAuditRow = {
  id: string;
  user_id: string;
  surface: string;
  entity: string;
  format: string;
  record_count: number;
  created_at: string;
};

export async function fetchExportAudit(limit = 200): Promise<ExportAuditRow[]> {
  const { data, error } = await supabase
    .from("export_audit")
    .select("id,user_id,surface,entity,format,record_count,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ExportAuditRow[];
}
