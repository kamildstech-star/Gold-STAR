/**
 * Emits the body of the page-access seed migration from the page catalogue, so
 * the SQL and `src/lib/page-access.ts` can never drift. Re-run and paste when
 * pages are added:
 *
 *   npx jiti scripts/gen-page-access-seed.ts
 *
 * The generated SQL is idempotent: run it as often as you like. It seeds the
 * `permissions` catalogue with one `page.<id>` row per page and seeds
 * `role_permissions` from each page's `defaultRoles`, which reproduce today's
 * sidebar. It never deletes a row an administrator has changed.
 */
import { PAGES, PAGE_AREAS, pagePermissionKey } from "../src/lib/page-access";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const lines: string[] = [];

lines.push("-- Catalogue: one row per page, grouped by area.");
lines.push(
  "INSERT INTO public.permissions (key, label, perm_group, description, sort_order) VALUES",
);
const catalogue = PAGES.map((p) => {
  // Areas are spaced 1000 apart so pages sort after the capability rows
  // (whose sort_order tops out around 140) and stay grouped by area.
  const order = (PAGE_AREAS.indexOf(p.area) + 1) * 1000 + PAGES.indexOf(p);
  const desc = p.note ?? `Page: ${p.path}`;
  return `  (${q(pagePermissionKey(p.id))}, ${q(p.label)}, ${q(`Pages · ${p.area}`)}, ${q(desc)}, ${order})`;
});
lines.push(catalogue.join(",\n"));
lines.push("ON CONFLICT (key) DO UPDATE SET");
lines.push("  label = EXCLUDED.label,");
lines.push("  perm_group = EXCLUDED.perm_group,");
lines.push("  description = EXCLUDED.description,");
lines.push("  sort_order = EXCLUDED.sort_order,");
lines.push("  updated_at = now();");
lines.push("");

lines.push("-- Role defaults, mirroring the sidebar as it behaves today.");
lines.push("INSERT INTO public.role_permissions (role, permission_key) VALUES");
const grants: string[] = [];
for (const p of PAGES) {
  for (const role of p.defaultRoles) {
    grants.push(`  (${q(role)}::public.app_role, ${q(pagePermissionKey(p.id))})`);
  }
}
lines.push(grants.join(",\n"));
lines.push("ON CONFLICT (role, permission_key) DO NOTHING;");

process.stdout.write(lines.join("\n") + "\n");
