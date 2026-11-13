import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MapPin, Pencil } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { OffboardingPanel } from "@/components/people/offboarding-panel";
import { PersonPayPanel } from "@/components/people/person-pay-panel";
import { ReassignBookPanel } from "@/components/people/reassign-book-panel";
import { RecordLoadError } from "@/components/record-load-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastDbError } from "@/lib/db-errors";
import {
  PEOPLE_QUERY_KEY,
  PEOPLE_STAGE_LABEL,
  PEOPLE_STAGE_TONE,
  PERSON_TABS,
  PERSON_TAB_LABEL,
  SETTABLE_STAGES,
  fetchPeople,
  setPersonEmployment,
  timeAtGoldStar,
  type PeopleStage,
  type PersonTab,
} from "@/lib/people";
import { isPrivileged } from "@/lib/roles";
import { useMyPageAccess } from "@/lib/use-page-access";
import { formatDateUS } from "@/lib/date-format";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * One person on People: who they are, where they stand, and the three things
 * that used to be separate pages — their pay and commission, the accounts
 * they hold, and their offboarding (Melly, 6 Nov).
 */

type Search = { tab: PersonTab };

export const Route = createFileRoute("/_authenticated/admin/people/$userId")({
  head: () => ({
    meta: [
      { title: "Person · Recovery Hub" },
      {
        name: "description",
        content: "One person's stage, pay and commission, book of accounts and offboarding.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): Search => ({
    tab: PERSON_TABS.includes(raw.tab as PersonTab) ? (raw.tab as PersonTab) : "pay",
  }),
  component: PersonPage,
});

function PersonPage() {
  const { userId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const app = useAppContext();
  const canEdit = isPrivileged(app.roles);
  const pageAccess = useMyPageAccess();
  // Reassigning a book is owners, admins and developers only, so the Book tab
  // is not offered to anyone else who has been given this page.
  const tabs: readonly PersonTab[] = canEdit
    ? PERSON_TABS
    : PERSON_TABS.filter((t) => t !== "book");

  const q = useQuery({ queryKey: PEOPLE_QUERY_KEY, queryFn: fetchPeople });
  const person = q.data?.people.find((p) => p.userId === userId) ?? null;

  if (q.error) {
    return (
      <RecordLoadError
        error={q.error}
        record="person"
        table="profiles"
        id={userId}
        onRetry={() => void q.refetch()}
      />
    );
  }
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!person) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">No such person.</p>
        <Link to="/admin/people" className="text-sm font-medium text-primary hover:underline">
          Back to People
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        to="/admin/people"
        className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> People
      </Link>

      <section className="flex flex-wrap items-start gap-4 rounded-xl border bg-card p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[20px] font-bold leading-tight text-foreground">{person.name}</h2>
            <span
              className={cn(
                "rounded-md border px-2 py-0.5 text-[12px] font-semibold",
                TONE[PEOPLE_STAGE_TONE[person.stage]],
              )}
              data-person-stage
            >
              {PEOPLE_STAGE_LABEL[person.stage]}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{person.titleOrRole}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            {person.officeName ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" /> {person.officeName}
              </span>
            ) : null}
            <span>{timeAtGoldStar(person.startedOn)} at Gold Star</span>
          </p>
        </div>
        {pageAccess.canOpen("/admin/users") && (
          <Button variant="outline" asChild>
            {/* Roles, offices and contact details stay where they are managed. */}
            <Link to="/admin/users/$userId" params={{ userId }}>
              <Pencil className="mr-1.5 size-4" /> Roles and access
            </Link>
          </Button>
        )}
        <EmploymentEditor
          userId={userId}
          stage={person.stage}
          storedStage={person.storedStage}
          startedOn={person.startedOnStored}
          canEdit={canEdit}
          locked={app.writesDisabled || !q.data?.stageStored}
        />
      </section>

      <Tabs
        value={tabs.includes(search.tab) ? search.tab : "pay"}
        onValueChange={(v) => navigate({ search: { tab: v as PersonTab }, replace: true })}
      >
        <TabsList aria-label={`${person.name}'s profile`}>
          {tabs.map((t) => (
            <TabsTrigger key={t} value={t}>
              {PERSON_TAB_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="pay" className="mt-3">
          <PersonPayPanel userId={userId} />
        </TabsContent>
        {canEdit ? (
          <TabsContent value="book" className="mt-3">
            <ReassignBookPanel key={userId} initialFromId={userId} />
          </TabsContent>
        ) : null}
        <TabsContent value="offboarding" className="mt-3">
          <OffboardingPanel key={userId} userId={userId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Stage and start date. Interviewing, Onboarding and Active are set here;
 * Offboarding and Former follow from the Offboarding tab's checklist and
 * lockout, so they are explained rather than offered.
 */
function EmploymentEditor({
  userId,
  stage,
  storedStage,
  startedOn,
  canEdit,
  locked,
}: {
  userId: string;
  stage: PeopleStage;
  storedStage: PeopleStage | null;
  startedOn: string | null;
  /** The role may change these. Without it they show as text, with no Save. */
  canEdit: boolean;
  /** View As preview, or the database update is missing: shown, switched off. */
  locked: boolean;
}) {
  const qc = useQueryClient();
  const derived = stage === "offboarding" || stage === "former";
  const [draftStage, setDraftStage] = useState<PeopleStage>(
    storedStage && SETTABLE_STAGES.includes(storedStage) ? storedStage : "active",
  );
  const [draftStart, setDraftStart] = useState(startedOn ?? "");
  useEffect(() => {
    setDraftStage(storedStage && SETTABLE_STAGES.includes(storedStage) ? storedStage : "active");
    setDraftStart(startedOn ?? "");
  }, [storedStage, startedOn]);

  const save = useMutation({
    mutationFn: () =>
      setPersonEmployment({
        userId,
        stage: draftStage === "active" ? null : draftStage,
        startedOn: draftStart || null,
      }),
    onSuccess: () => {
      toast.success("Saved");
      void qc.invalidateQueries({ queryKey: PEOPLE_QUERY_KEY });
    },
    onError: (e) => toastDbError(e, { action: "save the stage" }),
  });

  const dirty =
    draftStage !==
      (storedStage && SETTABLE_STAGES.includes(storedStage) ? storedStage : "active") ||
    draftStart !== (startedOn ?? "");

  return (
    <div className="grid w-full gap-3 border-t pt-3 sm:grid-cols-[minmax(0,220px)_minmax(0,200px)_auto] sm:items-end">
      <div className="space-y-1">
        <Label htmlFor="person-stage" className="text-[12px]">
          Stage
        </Label>
        {derived ? (
          <p className="text-[12px] text-muted-foreground" id="person-stage">
            {stage === "offboarding"
              ? "Offboarding — an offboarding checklist is open. Close it on the Offboarding tab."
              : "Former — this person's sign-in is deactivated."}
          </p>
        ) : !canEdit ? (
          <p className="text-[13px]" id="person-stage">
            {PEOPLE_STAGE_LABEL[draftStage]}
          </p>
        ) : (
          <Select
            value={draftStage}
            onValueChange={(v) => setDraftStage(v as PeopleStage)}
            disabled={locked}
          >
            <SelectTrigger id="person-stage" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETTABLE_STAGES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PEOPLE_STAGE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="person-start" className="text-[12px]">
          Started at Gold Star
        </Label>
        {canEdit ? (
          <Input
            id="person-start"
            type="date"
            className="h-9"
            value={draftStart}
            onChange={(e) => setDraftStart(e.target.value)}
            disabled={locked}
          />
        ) : (
          <p className="text-[13px]" id="person-start">
            {startedOn ? formatDateUS(startedOn) : "Not set"}
          </p>
        )}
      </div>
      {canEdit ? (
        <Button
          className="h-9"
          disabled={locked || !dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      ) : null}
    </div>
  );
}
