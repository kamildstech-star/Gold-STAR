// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark, 6 Oct: "clicking save estimate deletes the numbers you enter into
 * equipment." Live row 514265d4… was $2,350 that morning; he opened it,
 * clicked Save, and it was $1,745 with all fifteen equipment quantities 0.
 *
 * The cause was the read, not the write. `savedCalculationFromRow` spread the
 * customer pricing over the inputs, and the pricing's `equipment` (the priced
 * lines, an array) replaced the inputs' `equipment` (the quantity map). The
 * editor hydrated from that, every box looked up `equipment[key]` on an array
 * and read 0, and Save wrote the zeros back. A brand-new estimate saved fine,
 * which is why rows saved once in September still have their equipment.
 *
 * So this drives the real editor, the real React Query and the REAL
 * `savedCalculationFromRow`; only the network calls are stubbed. A stub that
 * built the saved model itself would have hidden exactly this bug.
 *
 * No DOM testing library, per the brief: `react-dom/client` and `act`, as in
 * number-input.caret.test.tsx.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => createElement("a", null, children),
  useNavigate: () => vi.fn(),
  useRouter: () => ({
    history: { location: { state: {} }, canGoBack: () => false, back: vi.fn() },
  }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: "/estimates/calc-1", search: {}, searchStr: "" } }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "qa-user", currentLocationId: "loc-1", writesDisabled: false }),
}));
vi.mock("@/components/location-picker", () => ({
  LocationPicker: () => null,
  useWritableLocations: () => [],
  useJobCreatableLocations: () => [],
}));
vi.mock("@/lib/use-own-location", () => ({
  useOwnLocationId: () => null,
  useLocationChoice: () => "all",
}));
vi.mock("@/components/address-autocomplete", () => ({ AddressAutocomplete: () => null }));
// The type-ahead searches the CRM; nothing here is about the customer.
vi.mock("@/components/customer-picker", () => ({
  CustomerPicker: () => null,
  emptyCustomer: (kind: string, name: string) => ({ kind, name }),
}));
vi.mock("@/components/pdf-preview-dialog", () => ({ PdfPreviewDialog: () => null }));
vi.mock("@/lib/permissions", () => ({ useCan: () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/quick-estimate-statements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quick-estimate-statements")>();
  return {
    ...actual,
    loadQuickEstimateStatements: vi.fn(async () => actual.DEFAULT_QUICK_ESTIMATE_STATEMENTS),
  };
});
// A failed rate read falls back to the built-in rates, which is what is wanted.
vi.mock("@/lib/job-calculator-pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/job-calculator-pricing")>();
  return {
    ...actual,
    fetchCalculatorRates: vi.fn(async () => {
      throw new Error("offline");
    }),
  };
});
vi.mock("@/lib/job-calculations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/job-calculations")>();
  return {
    ...actual,
    attachJobCalculation: vi.fn(),
    listJobsForCalculation: vi.fn(async () => []),
    loadJobCalculation: vi.fn(),
    saveJobCalculation: vi.fn(),
  };
});

import { JobCalculatorEditor } from "./job-calculator-editor";
import {
  loadJobCalculation,
  saveJobCalculation,
  savedCalculationFromRow,
  type JobCalculationRow,
} from "@/lib/job-calculations";
import {
  calculateCustomerPricing,
  emptyJobCalculationInput,
  normalizeEquipment,
  type JobCalculationInput,
} from "@/lib/job-calculator";

/** The row PostgREST hands back, as `saveJobCalculation` would have written it. */
function rowFor(input: JobCalculationInput, updatedAt: string): JobCalculationRow {
  return {
    id: "calc-1",
    location_id: "loc-1",
    job_id: null,
    job_date: input.jobDate,
    customer_name: input.customerName || null,
    contact_number: input.contactNumber || null,
    email: input.email || null,
    address: input.address || null,
    address_line2: input.addressLine2 || null,
    locality: input.locality || null,
    region: input.region || null,
    postal_code: input.postalCode || null,
    job_type: input.jobType,
    days: input.days,
    workers: input.workers,
    regular_hours: input.regularHours,
    after_hours: input.afterHours,
    emergency: input.emergency,
    garbage_fee: input.garbageFee,
    miscellaneous_fee: input.miscellaneousFee,
    equipment_quantities: normalizeEquipment(input.equipment),
    customer_price: calculateCustomerPricing(input).customerPrice,
    created_by: "qa-user",
    created_at: "2026-10-06T09:00:00Z",
    updated_at: updatedAt,
  };
}

/** Shaped like row 514265d4…: water, one day, two workers — with equipment. */
const STORED: JobCalculationInput = {
  ...emptyJobCalculationInput(),
  jobDate: "2026-10-06",
  jobType: "water",
  days: 1,
  workers: 2,
  equipment: { ...emptyJobCalculationInput().equipment, air_mover: 6, dehumidifier: 2 },
};
const STORED_ROW = rowFor(STORED, "2026-10-06T09:00:00Z");

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(loadJobCalculation).mockReset();
  vi.mocked(saveJobCalculation).mockReset();
  vi.mocked(saveJobCalculation).mockImplementation(async ({ input }) =>
    savedCalculationFromRow(rowFor(input, "2026-10-06T17:08:54Z")),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  focusManager.setFocused(undefined);
});

/** Let queries resolve and effects settle. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(props: Parameters<typeof JobCalculatorEditor>[0]) {
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(JobCalculatorEditor, props)),
    );
  });
  await settle();
}

function box(label: string) {
  const el = container.querySelector<HTMLInputElement>(`input[aria-label="${label} quantity"]`);
  if (!el) throw new Error(`no ${label} box`);
  return el;
}

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

/** Replace the box's text one keystroke at a time, the way a browser would. */
function typeInto(input: HTMLInputElement, text: string) {
  setNativeValue.call(input, "");
  for (const ch of text) {
    act(() => {
      const raw = input.value + ch;
      setNativeValue.call(input, raw);
      input.setSelectionRange(raw.length, raw.length);
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }),
      );
    });
  }
}

async function saveAndCapture() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save estimate"),
  );
  if (!button) throw new Error("no Save estimate button");
  await act(async () => {
    button.click();
  });
  await settle();
  const calls = vi.mocked(saveJobCalculation).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![0].input;
}

describe("Save estimate keeps the equipment", () => {
  it("opening a saved estimate shows its equipment, and Save with no edits writes it back", async () => {
    vi.mocked(loadJobCalculation).mockResolvedValue(savedCalculationFromRow(STORED_ROW));
    await mount({ calculationId: "calc-1" });

    expect(box("Air mover").value).toBe("6");
    expect(box("Dehumidifier").value).toBe("2");

    const saved = await saveAndCapture();
    expect(normalizeEquipment(saved.equipment)).toEqual(normalizeEquipment(STORED.equipment));
    // The $605-style drop: the quote still includes the equipment.
    expect(calculateCustomerPricing(saved).customerPrice).toBe(STORED_ROW.customer_price);
  });

  it("still shows the equipment after Save refetches the estimate", async () => {
    vi.mocked(loadJobCalculation)
      .mockResolvedValueOnce(savedCalculationFromRow(STORED_ROW))
      .mockResolvedValue(savedCalculationFromRow(rowFor(STORED, "2026-10-06T17:08:54Z")));
    await mount({ calculationId: "calc-1" });
    await saveAndCapture();

    // Save invalidates ["job-calculation", id]; the reload must not zero the boxes.
    expect(vi.mocked(loadJobCalculation).mock.calls.length).toBeGreaterThan(1);
    expect(box("Air mover").value).toBe("6");
    expect(box("Dehumidifier").value).toBe("2");
  });

  it("a new estimate saves the equipment typed into it", async () => {
    await mount({ prefill: { jobDate: "2026-10-06", locationId: "loc-1" } });
    typeInto(box("Air mover"), "6");
    typeInto(box("Scrubber XL"), "1");

    const saved = await saveAndCapture();
    expect(saved.equipment.air_mover).toBe(6);
    expect(saved.equipment.scrubber_xl).toBe(1);
  });

  it("equipment typed into a saved estimate survives a window-focus refetch", async () => {
    // Every read answers with a fresh copy of the same row, as the server does.
    vi.mocked(loadJobCalculation).mockImplementation(async () =>
      savedCalculationFromRow(STORED_ROW),
    );
    await mount({ calculationId: "calc-1" });
    typeInto(box("Scrubber XL"), "3");

    const readsBefore = vi.mocked(loadJobCalculation).mock.calls.length;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();
    // The refetch really happened; structural sharing keeps the same data
    // object for an unchanged row, so the hydrate does not run over the edit.
    expect(vi.mocked(loadJobCalculation).mock.calls.length).toBeGreaterThan(readsBefore);
    expect(box("Scrubber XL").value).toBe("3");

    const saved = await saveAndCapture();
    expect(saved.equipment.scrubber_xl).toBe(3);
    expect(saved.equipment.air_mover).toBe(6);
    expect(saved.equipment.dehumidifier).toBe(2);
  });
});
