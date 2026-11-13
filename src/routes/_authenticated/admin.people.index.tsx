import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BadgePercent,
  CircleCheck,
  LogOut,
  MapPin,
  Search,
  UserPlus,
  UserRoundCheck,
  UserRoundSearch,
  UserRoundX,
} from "lucide-react";

import { CommissionTierCard } from "@/components/commission-tier-card";
import { MetricRow, MetricStat } from "@/components/metric-stat";
import { RecordLoadError } from "@/components/record-load-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  PEOPLE_QUERY_KEY,
  PEOPLE_STAGES,
  PEOPLE_STAGE_LABEL,
  PEOPLE_STAGE_TONE,
  countStages,
  fetchPeople,
  timeAtGoldStar,
  type PeopleStage,
  type Person,
} from "@/lib/people";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * People — everyone at Gold Star, in one place.
 *
 * Melly, 6 Nov: "Reassign a book, People and pay, Offboarding … were added
 * because of one conversation … instead you could have one tab which is just
 * people at the company." And: "it could look exactly like [Vendors] … how
 * many we're hiring, active, letting go, and if you go to them you'll see a
 * box with their name you can click into." So: a count per stage on top (each
 * one a filter), search, then a box per person. Their pay and commission,
 * their book and their offboarding are tabs on the profile a box opens.
 */

type StageFilter = PeopleStage | "current" | "all";
type Search = { q: string; stage: StageFilter };

const FILTERS: StageFilter[] = ["current", "all", ...PEOPLE_STAGES];

export const Route = createFileRoute("/_authenticated/admin/people/")({
  head: () => ({
    meta: [
      { title: "People · Recovery Hub" },
      {
        name: "description",
        content:
          "Everyone at Gold Star by stage — interviewing, onboarding, active, offboarding, former — with pay, book and offboarding on each profile.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): Search => ({
    q: typeof raw.q === "string" ? raw.q : "",
    stage: FILTERS.includes(raw.stage as StageFilter) ? (raw.stage as StageFilter) : "current",
  }),
  component: PeoplePage,
});

const STAGE_ICON: Record<PeopleStage, typeof CircleCheck> = {
  interviewing: UserRoundSearch,
  onboarding: UserPlus,
  active: UserRoundCheck,
  offboarding: LogOut,
  former: UserRoundX,
};

const STAGE_TINT: Record<PeopleStage, string> = {
  interviewing: "var(--info)",
  onboarding: "var(--link)",
  active: "var(--success)",
  offboarding: "var(--warning)",
  former: "var(--muted-foreground)",
};

/** Two initials, for the avatar. */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

function PeoplePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [tiersOpen, setTiersOpen] = useState(false);

  const q = useQuery({ queryKey: PEOPLE_QUERY_KEY, queryFn: fetchPeople });
  const people = useMemo(() => q.data?.people ?? [], [q.data]);
  const counts = useMemo(() => countStages(people), [people]);

  const shown = useMemo(() => {
    const needle = search.q.trim().toLowerCase();
    return people
      .filter((p) => {
        if (search.stage === "current" && p.stage === "former") return false;
        if (search.stage !== "current" && search.stage !== "all" && p.stage !== search.stage)
          return false;
        if (!needle) return true;
        return [p.name, p.titleOrRole, p.officeName ?? ""].some((v) =>
          v.toLowerCase().includes(needle),
        );
      })
      .sort(
        (a, b) =>
          PEOPLE_STAGES.indexOf(a.stage) - PEOPLE_STAGES.indexOf(b.stage) ||
          a.name.localeCompare(b.name),
      );
  }, [people, search.q, search.stage]);

  const setStage = (stage: StageFilter) =>
    navigate({
      search: (p: Search) => ({ ...p, stage: p.stage === stage ? "current" : stage }),
      replace: true,
    });

  if (q.error) {
    return (
      <RecordLoadError
        error={q.error}
        record="people"
        table="profiles"
        onRetry={() => void q.refetch()}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          Everyone at Gold Star. Open a person for their pay and commission, the accounts they hold,
          and their offboarding.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setTiersOpen(true)}>
            <BadgePercent className="mr-1.5 size-4" /> Commission tiers
          </Button>
          <Button asChild>
            {/* A hire starts as an invited user; their stage is set on the profile. */}
            <Link to="/admin/users">
              <UserPlus className="mr-1.5 size-4" /> Add person
            </Link>
          </Button>
        </div>
      </div>

      <MetricRow>
        {PEOPLE_STAGES.map((s) => {
          const Icon = STAGE_ICON[s];
          const on = search.stage === s;
          return (
            <MetricStat
              key={s}
              value={counts[s]}
              label={PEOPLE_STAGE_LABEL[s]}
              icon={<Icon className="size-5" />}
              iconTint={STAGE_TINT[s]}
              compactOnPhone
              onClick={() => setStage(s)}
              className={cn(on && "ring-2 ring-primary ring-offset-1 ring-offset-background")}
            />
          );
        })}
      </MetricRow>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          {/* 16px below sm: iOS zooms into any smaller field on focus. */}
          <Input
            className="h-11 pl-8 text-base sm:h-9 sm:text-[13px]"
            placeholder="Search name, title or office"
            value={search.q}
            onChange={(e) =>
              navigate({ search: (p: Search) => ({ ...p, q: e.target.value }), replace: true })
            }
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[12px]">
          {(["current", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() =>
                navigate({ search: (p: Search) => ({ ...p, stage: f }), replace: true })
              }
              aria-pressed={search.stage === f}
              className={cn(
                "rounded-md border px-2.5 py-1 font-medium",
                search.stage === f
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "current" ? "Current staff" : "Everyone"}
            </button>
          ))}
          {search.stage !== "current" && search.stage !== "all" ? (
            <span className="ml-1 text-muted-foreground">
              Showing {PEOPLE_STAGE_LABEL[search.stage]}
            </span>
          ) : null}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {shown.length} of {people.length}
        </span>
      </div>

      {q.isLoading ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">Loading people…</p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border bg-card py-8 text-center text-[13px] text-muted-foreground">
          {people.length === 0 ? "Nobody here yet." : "Nobody matches that."}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-people-list>
          {shown.map((p) => (
            <PersonBox key={p.userId} person={p} />
          ))}
        </ul>
      )}

      <Dialog open={tiersOpen} onOpenChange={setTiersOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Commission tiers</DialogTitle>
          </DialogHeader>
          {tiersOpen && <CommissionTierCard />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PersonBox({ person: p }: { person: Person }) {
  return (
    <li>
      <Link
        to="/admin/people/$userId"
        params={{ userId: p.userId }}
        className="flex h-full items-start gap-3 rounded-xl border bg-card p-3.5 transition-shadow hover:border-primary/40 hover:shadow-[var(--card-shadow-hover)]"
        data-person-box
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-[13px] font-semibold text-foreground">
          {initials(p.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0 truncate text-[14px] font-semibold text-foreground">
              {p.name}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
                TONE[PEOPLE_STAGE_TONE[p.stage]],
              )}
            >
              {PEOPLE_STAGE_LABEL[p.stage]}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
            {p.titleOrRole}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
            {p.officeName ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3" /> {p.officeName}
              </span>
            ) : null}
            <span>{timeAtGoldStar(p.startedOn)} at Gold Star</span>
            {p.isDemo ? <span className="text-[11px]">Demo</span> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}
