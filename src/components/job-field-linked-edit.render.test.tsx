// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec BC-CON-1: editing a person on a job who was picked from a company's
 * records asks "update the company record" or "change for this job only". The
 * job keeps its own copy either way — so both answers write the job, and only
 * one of them also writes the contact.
 *
 * Drives the real JobField with a linked desk adjuster's phone. The alert
 * dialog is a plain element so the buttons can be pressed in jsdom.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "user-1", roles: ["office"], writesDisabled: false }),
}));
vi.mock("@/lib/job-field-access", () => ({
  useJobFieldAccess: () => ({ canSee: () => true, canEdit: () => true }),
}));
vi.mock("@/lib/job-stages", () => ({
  useJobStages: () => ({ stages: [], stageById: new Map() }),
}));
vi.mock("@/components/ui/alert-dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? createElement("div", { role: "alertdialog" }, children) : null,
    AlertDialogContent: Pass,
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: Pass,
    AlertDialogDescription: Pass,
    AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
      createElement("button", { onClick }, children),
    AlertDialogCancel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) =>
      createElement("button", { onClick }, children),
  };
});

const writes = vi.hoisted(() => ({
  saveJobField: vi.fn(async () => true),
  updateJobFields: vi.fn(async () => true),
  updateJobFieldsQueued: vi.fn(async () => ({ ok: true, queued: false })),
  updateCompanyPerson: vi.fn(async () => undefined),
}));
vi.mock("@/lib/job-update", () => ({
  saveJobField: writes.saveJobField,
  updateJobFields: writes.updateJobFields,
  updateJobFieldsQueued: writes.updateJobFieldsQueued,
}));
vi.mock("@/lib/company-people", async (orig) => ({
  ...(await orig<typeof import("@/lib/company-people")>()),
  updateCompanyPerson: writes.updateCompanyPerson,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));

import { JobField, type LinkedPerson } from "./job-inline-field";

const job = {
  id: "job-1",
  desk_adjuster_name: "Dana Ruiz",
  desk_adjuster_phone: "845-555-0100",
  desk_adjuster_contact_id: "dana",
};
const linked: LinkedPerson = {
  contactId: "dana",
  personName: "Dana Ruiz",
  companyName: "State Farm",
  field: "phone",
  canUpdateRecord: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(link: LinkedPerson | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(JobField, {
          job,
          fieldKey: "desk_adjuster_phone",
          label: "Phone",
          linked: link,
        }),
      ),
    );
  });
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

/** Click the value, type a new number, press Enter. */
function editTo(value: string) {
  act(() => button("845-555-0100")!.click());
  const input = container.querySelector<HTMLInputElement>("input")!;
  act(() => {
    setNativeValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("editing a picked person's details on the job", () => {
  it("asks before saving, and writes nothing until answered", () => {
    mount(linked);
    editTo("914-555-0177");
    expect(container.querySelector("[role=alertdialog]")?.textContent).toContain(
      "Dana Ruiz was picked from State Farm",
    );
    expect(writes.saveJobField).not.toHaveBeenCalled();
    expect(writes.updateCompanyPerson).not.toHaveBeenCalled();
  });

  it("“this job only” changes the job's copy and leaves the record alone", async () => {
    mount(linked);
    editTo("914-555-0177");
    await act(async () => button("Change for this job only")!.click());
    expect(writes.saveJobField).toHaveBeenCalledWith(
      "job-1",
      "desk_adjuster_phone",
      "914-555-0177",
      "Phone",
    );
    expect(writes.updateCompanyPerson).not.toHaveBeenCalled();
  });

  it("“update the company record” writes the contact and the job", async () => {
    mount(linked);
    editTo("914-555-0177");
    await act(async () => button("Update the company record too")!.click());
    expect(writes.updateCompanyPerson).toHaveBeenCalledWith("dana", { phone: "914-555-0177" });
    expect(writes.saveJobField).toHaveBeenCalledWith(
      "job-1",
      "desk_adjuster_phone",
      "914-555-0177",
      "Phone",
    );
  });

  it("offers job-only to someone who may not edit the company's people", () => {
    mount({ ...linked, canUpdateRecord: false });
    editTo("914-555-0177");
    expect(button("Update the company record too")).toBeUndefined();
    expect(button("Change for this job only")).toBeTruthy();
  });

  it("saves a hand-typed value straight away — there is no record to ask about", () => {
    mount(null);
    editTo("914-555-0177");
    expect(container.querySelector("[role=alertdialog]")).toBeNull();
    expect(writes.saveJobField).toHaveBeenCalled();
  });
});
