import { ROLE_LABELS, type AppRole } from "@/lib/roles";

export interface PickablePersonLabel {
  full_name: string | null;
  email: string | null;
  roles: string[];
}

export function roleText(roles: string[]): string {
  if (roles.length === 0) return "No role set";
  return roles.map((role) => ROLE_LABELS[role as AppRole] ?? role).join(" · ");
}

export function personSearchValue(person: PickablePersonLabel): string {
  return `${person.full_name ?? ""} ${person.email ?? ""}`.trim();
}

export function personPrimaryLabel(person: PickablePersonLabel): string {
  return person.full_name ?? person.email ?? "Unnamed";
}

export function personSecondaryLabel(person: PickablePersonLabel): string {
  return [person.email, roleText(person.roles)].filter(Boolean).join(" · ");
}
