/**
 * David's Job Calculator workbook, expressed as a small auditable model.
 *
 * Workbook mapping (Book1.xlsx):
 * - Job Calculator!G10: daily supply charge by job type.
 * - Job Calculator!H10: $100 truck charge per day.
 * - Job Calculator!J10: $70 regular hours, $105 after-hours, and a $100
 *   emergency bonus per worker.
 * - Job Calculator!J30: labor internal cost is 0.642858 of labor revenue and
 *   truck internal cost is $50 per day.
 * - Item Cost!A5:C19: equipment customer and internal unit rates.
 *
 * The source workbook's J14:J27 formulas accidentally point at I140:I153 and
 * J32 has no formula. We use the visible unit-rate tables directly and define
 * equipment/overall profit from first principles so those spreadsheet defects
 * cannot silently zero the app's results.
 */
import { roundMoney } from "@/lib/money";

export const JOB_CALCULATOR_TYPES = ["water", "mold", "fire_smoke"] as const;
export type JobCalculatorType = (typeof JOB_CALCULATOR_TYPES)[number];

export const JOB_CALCULATOR_TYPE_LABEL: Record<JobCalculatorType, string> = {
  water: "Water",
  mold: "Mold",
  fire_smoke: "Fire / Smoke",
};

export type EquipmentKey =
  | "boarding"
  | "air_mover"
  | "scrubber_xl"
  | "scrubber_xl_filter"
  | "scrubber_xxl"
  | "scrubber_xxl_filter"
  | "dehumidifier"
  | "truck_mount_hour"
  | "generator"
  | "encapsulation_bucket"
  | "air_samples"
  | "injector"
  | "ozone"
  | "hydroxyl"
  | "submersible_pump";

export type EquipmentDefinition = {
  key: EquipmentKey;
  label: string;
  unit: string;
  customerRate: number;
  internalRate: number;
};

export const EQUIPMENT_DEFINITIONS: readonly EquipmentDefinition[] = [
  { key: "boarding", label: "Boarding", unit: "each", customerRate: 750, internalRate: 0 },
  { key: "air_mover", label: "Air mover", unit: "day", customerRate: 45, internalRate: 5 },
  { key: "scrubber_xl", label: "Scrubber XL", unit: "day", customerRate: 200, internalRate: 10 },
  {
    key: "scrubber_xl_filter",
    label: "Scrubber XL with filter",
    unit: "day",
    customerRate: 250,
    internalRate: 10,
  },
  { key: "scrubber_xxl", label: "Scrubber XXL", unit: "day", customerRate: 250, internalRate: 15 },
  {
    key: "scrubber_xxl_filter",
    label: "Scrubber XXL with filter",
    unit: "day",
    customerRate: 300,
    internalRate: 10,
  },
  { key: "dehumidifier", label: "Dehumidifier", unit: "day", customerRate: 225, internalRate: 20 },
  {
    key: "truck_mount_hour",
    label: "Truck mount",
    unit: "hour",
    customerRate: 220,
    internalRate: 0,
  },
  { key: "generator", label: "Generator", unit: "day", customerRate: 80, internalRate: 10 },
  {
    key: "encapsulation_bucket",
    label: "Encapsulation",
    unit: "bucket",
    customerRate: 500,
    internalRate: 200,
  },
  // The calculator sheet displays $500. The separate Item Cost sheet says
  // $600, so we deliberately follow the customer-facing calculator cell I24.
  {
    key: "air_samples",
    label: "Air samples (up to 4)",
    unit: "set",
    customerRate: 500,
    internalRate: 175,
  },
  { key: "injector", label: "Injector", unit: "day", customerRate: 100, internalRate: 10 },
  { key: "ozone", label: "Ozone", unit: "day", customerRate: 250, internalRate: 10 },
  { key: "hydroxyl", label: "Hydroxyl", unit: "day", customerRate: 250, internalRate: 20 },
  // The workbook leaves the customer rate blank. Keep it at zero until David
  // supplies a charge instead of inventing a price.
  {
    key: "submersible_pump",
    label: "Submersible pump",
    unit: "day",
    customerRate: 0,
    internalRate: 5,
  },
] as const;

export type EquipmentQuantities = Partial<Record<EquipmentKey, number>>;

export type JobCalculationInput = {
  jobDate: string;
  jobType: JobCalculatorType;
  customerName: string;
  contactNumber: string;
  email: string;
  address: string;
  addressLine2: string;
  locality: string;
  region: string;
  postalCode: string;
  days: number;
  workers: number;
  regularHours: number;
  afterHours: number;
  emergency: boolean;
  garbageFee: number;
  miscellaneousFee: number;
  equipment: EquipmentQuantities;
  /**
   * One optional note, printed with the estimate.
   *
   * David, 17 Sep: "maybe a small little section if we want to put in a note."
   * One box, not a section: the quick estimate is used standing on a driveway
   * — "tap, tap, tap, and you have your estimate" — so typing is never
   * required, and an empty note prints nothing at all.
   */
  note: string;
  /**
   * Anything the printed list does not have a row for.
   *
   * David, 16 Sep, asked for a way to add blank lines at the bottom of the
   * calculator and type into them. The catalogue above is deliberately fixed —
   * it is what keeps two people pricing the same job the same way — so a job
   * that needs a dumpster permit or a specialist sub gets a line here instead
   * of somebody bending "Miscellaneous" to mean four different things.
   */
  customLines: CustomLine[];
};

/** One free-typed line: what it is, and what the customer is charged for it. */
export type CustomLine = {
  label: string;
  amount: number;
};

/** A blank row for the editor to append. */
export function emptyCustomLine(): CustomLine {
  return { label: "", amount: 0 };
}

/**
 * The lines worth keeping: a row with neither a name nor a price is a blank the
 * user added and never filled, and it is dropped rather than saved or printed.
 */
export function usableCustomLines(lines: readonly CustomLine[] | undefined): CustomLine[] {
  return (lines ?? [])
    .map((l) => ({ label: (l.label ?? "").trim(), amount: nonNegative(Number(l.amount ?? 0)) }))
    .filter((l) => l.label.length > 0 || l.amount > 0);
}

export function customLinesTotal(lines: readonly CustomLine[] | undefined): number {
  return roundCurrency(usableCustomLines(lines).reduce((sum, l) => sum + l.amount, 0));
}

/**
 * The model is split along the line `job.view_costs` draws.
 *
 * `CustomerPricing` is what the customer is quoted: every figure on it is
 * printed on the customer PDF and may be shown to anyone who can open the
 * calculator. `InternalFigures` is what the job costs Gold Star and the
 * margin on it. The two are computed by separate functions so a screen for
 * someone without `job.view_costs` can price the job without the internal
 * numbers ever being calculated — not hidden by CSS, not sitting in a memo
 * or a query cache, simply never produced. `calculateJob` joins the two for
 * callers that hold the privilege (and for the saved snapshot).
 */
export type EquipmentPricing = Pick<
  EquipmentDefinition,
  "key" | "label" | "unit" | "customerRate"
> & {
  quantity: number;
  customerTotal: number;
};

export type CustomerPricing = {
  supplyCost: number;
  truckCustomerPrice: number;
  regularLaborPrice: number;
  afterHoursLaborPrice: number;
  emergencyWorkerBonuses: number;
  laborCustomerPrice: number;
  equipmentCustomerPrice: number;
  /** The typed-in lines, cleaned, and what they add up to. */
  customLines: CustomLine[];
  customLinesPrice: number;
  customerPrice: number;
  equipment: EquipmentPricing[];
};

export type EquipmentInternal = {
  key: EquipmentKey;
  internalRate: number;
  internalTotal: number;
  profit: number;
};

export type InternalFigures = {
  truckInternalCost: number;
  laborInternalCost: number;
  equipmentInternalCost: number;
  equipmentProfit: number;
  internalCost: number;
  overallProfit: number;
  equipment: EquipmentInternal[];
};

export type EquipmentCalculation = EquipmentDefinition & {
  quantity: number;
  customerTotal: number;
  internalTotal: number;
  profit: number;
};

export type JobCalculationResult = Omit<CustomerPricing, "equipment"> &
  Omit<InternalFigures, "equipment"> & {
    equipment: EquipmentCalculation[];
  };

/**
 * A saved calculation as the client reads it back: the inputs, the customer
 * pricing recomputed from them, and the row's identity. Deliberately NOT the
 * internal figures — the stored `internal_cost` / `equipment_profit` /
 * `overall_profit` columns are withheld from the `authenticated` role
 * (20260909110000_calculator_cost_visibility) and the editor recomputes them
 * live for holders of `job.view_costs` only.
 *
 * `equipment` is the inputs' QUANTITY map, never the priced lines. Both types
 * have a field by that name, and the priced one used to be spread over the
 * quantities when a row was read back, so a reopened estimate carried an
 * array where the editor looks up `equipment[key]`. Every box read 0 and the
 * next Save stored zeros: Mark, 6 Oct, "clicking save estimate deletes the
 * numbers you enter into equipment." The priced lines are one
 * `calculateCustomerPricing(saved)` away for anything that wants them.
 */
export type SavedJobCalculation = JobCalculationInput &
  Omit<CustomerPricing, "equipment"> & {
    id: string;
    locationId: string;
    jobId: string | null;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  };

const SUPPLY_RATE_PER_DAY: Record<JobCalculatorType, number> = {
  water: 250,
  mold: 250,
  fire_smoke: 300,
};

/**
 * The customer-facing rates, as one value the caller can substitute.
 *
 * These used to be read straight off `JOB_CALCULATOR_RATES` inside
 * `calculateCustomerPricing`, which is why a price list could not reach the
 * calculator: there was nothing to hand it. The constants below are still the
 * defaults and still the last-resort answer — see src/lib/job-calculator-pricing.ts
 * for the five-layer resolution that produces one of these.
 *
 * Only SELL rates are here. `laborInternalFactor` and `truckInternalPerDay`
 * stay on the constants and out of this type on purpose: a price list carries
 * no cost column, so no list can move what a job costs Gold Star, and the
 * margin shown to a `job.view_costs` holder cannot be edited by an office
 * admin through Admin -> Price lists.
 */
export type CalculatorRates = {
  regularLabor: number;
  afterHoursLabor: number;
  emergencyBonusPerWorker: number;
  truckCustomerPerDay: number;
  suppliesPerDay: Record<JobCalculatorType, number>;
  /** Customer rate per equipment key. */
  equipment: Record<EquipmentKey, number>;
};

export const JOB_CALCULATOR_RATES = {
  regularLabor: 70,
  afterHoursLabor: 105,
  emergencyBonusPerWorker: 100,
  laborInternalFactor: 0.642858,
  truckCustomerPerDay: 100,
  truckInternalPerDay: 50,
  suppliesPerDay: SUPPLY_RATE_PER_DAY,
} as const;

/**
 * The workbook constants in `CalculatorRates` shape — layer 5, the answer when
 * no catalog item and no price list has anything to say. Lives here rather
 * than in job-calculator-pricing.ts so that module can import from this one
 * without the dependency pointing both ways.
 */
export function defaultCalculatorRates(): CalculatorRates {
  return {
    regularLabor: JOB_CALCULATOR_RATES.regularLabor,
    afterHoursLabor: JOB_CALCULATOR_RATES.afterHoursLabor,
    emergencyBonusPerWorker: JOB_CALCULATOR_RATES.emergencyBonusPerWorker,
    truckCustomerPerDay: JOB_CALCULATOR_RATES.truckCustomerPerDay,
    suppliesPerDay: { ...JOB_CALCULATOR_RATES.suppliesPerDay },
    equipment: Object.fromEntries(
      EQUIPMENT_DEFINITIONS.map((item) => [item.key, item.customerRate]),
    ) as Record<EquipmentKey, number>,
  };
}

export function emptyEquipment(): EquipmentQuantities {
  return Object.fromEntries(EQUIPMENT_DEFINITIONS.map((item) => [item.key, 0]));
}

export function emptyJobCalculationInput(): JobCalculationInput {
  return {
    jobDate: new Date().toISOString().slice(0, 10),
    jobType: "water",
    customerName: "",
    contactNumber: "",
    email: "",
    address: "",
    addressLine2: "",
    locality: "",
    region: "",
    postalCode: "",
    days: 1,
    workers: 1,
    regularHours: 0,
    afterHours: 0,
    emergency: false,
    garbageFee: 0,
    miscellaneousFee: 0,
    equipment: emptyEquipment(),
    note: "",
    customLines: [],
  };
}

export function roundCurrency(value: number) {
  return roundMoney(value);
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeEquipment(value: unknown): EquipmentQuantities {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    EQUIPMENT_DEFINITIONS.map((item) => [item.key, nonNegative(Number(raw[item.key] ?? 0))]),
  );
}

/**
 * What the customer is quoted. Touches no internal rate: `internalRate`,
 * `laborInternalFactor` and `truckInternalPerDay` are not read here.
 *
 * `rates` defaults to the workbook constants, so every existing caller and the
 * PDF builder behave exactly as before. The editor passes the resolved rates
 * for the picked customer instead — see src/lib/job-calculator-pricing.ts.
 */
export function calculateCustomerPricing(
  input: JobCalculationInput,
  rates: CalculatorRates = defaultCalculatorRates(),
): CustomerPricing {
  const days = nonNegative(input.days);
  const workers = nonNegative(input.workers);
  const regularHours = nonNegative(input.regularHours);
  const afterHours = nonNegative(input.afterHours);
  const garbageFee = nonNegative(input.garbageFee);
  const miscellaneousFee = nonNegative(input.miscellaneousFee);
  const quantities = normalizeEquipment(input.equipment);

  const regularLaborPrice = roundCurrency(days * workers * regularHours * rates.regularLabor);
  const afterHoursLaborPrice = roundCurrency(days * workers * afterHours * rates.afterHoursLabor);
  const emergencyWorkerBonuses = input.emergency
    ? roundCurrency(workers * rates.emergencyBonusPerWorker)
    : 0;
  const laborCustomerPrice = roundCurrency(
    regularLaborPrice + afterHoursLaborPrice + emergencyWorkerBonuses,
  );

  const supplyCost = roundCurrency(rates.suppliesPerDay[input.jobType] * days);
  const truckCustomerPrice = roundCurrency(rates.truckCustomerPerDay * days);

  const equipment = EQUIPMENT_DEFINITIONS.map(({ key, label, unit, customerRate }) => {
    const quantity = nonNegative(Number(quantities[key] ?? 0));
    // The list price for this unit if one was resolved, else the workbook rate.
    const rate = rates.equipment[key] ?? customerRate;
    return {
      key,
      label,
      unit,
      customerRate: rate,
      quantity,
      customerTotal: roundCurrency(quantity * rate),
    };
  });

  const equipmentCustomerPrice = roundCurrency(
    equipment.reduce((total, item) => total + item.customerTotal, 0),
  );

  const customLines = usableCustomLines(input.customLines);
  const customLinesPrice = customLinesTotal(customLines);

  const customerPrice = roundCurrency(
    garbageFee +
      miscellaneousFee +
      supplyCost +
      truckCustomerPrice +
      laborCustomerPrice +
      equipmentCustomerPrice +
      customLinesPrice,
  );

  return {
    supplyCost,
    truckCustomerPrice,
    regularLaborPrice,
    afterHoursLaborPrice,
    emergencyWorkerBonuses,
    laborCustomerPrice,
    equipmentCustomerPrice,
    customLines,
    customLinesPrice,
    customerPrice,
    equipment,
  };
}

/**
 * What the job costs Gold Star, and the margin on it. Call this only for a
 * viewer who holds `job.view_costs`: it is the one place the internal rates
 * are applied.
 */
export function calculateInternalFigures(
  input: JobCalculationInput,
  pricing: CustomerPricing = calculateCustomerPricing(input),
): InternalFigures {
  const days = nonNegative(input.days);
  const garbageFee = nonNegative(input.garbageFee);
  const miscellaneousFee = nonNegative(input.miscellaneousFee);
  const quantities = normalizeEquipment(input.equipment);

  const laborInternalCost = roundCurrency(
    pricing.laborCustomerPrice * JOB_CALCULATOR_RATES.laborInternalFactor,
  );
  const truckInternalCost = roundCurrency(JOB_CALCULATOR_RATES.truckInternalPerDay * days);

  const equipment = EQUIPMENT_DEFINITIONS.map((item) => {
    const quantity = nonNegative(Number(quantities[item.key] ?? 0));
    const customerTotal = roundCurrency(quantity * item.customerRate);
    const internalTotal = roundCurrency(quantity * item.internalRate);
    return {
      key: item.key,
      internalRate: item.internalRate,
      internalTotal,
      profit: roundCurrency(customerTotal - internalTotal),
    };
  });

  const equipmentInternalCost = roundCurrency(
    equipment.reduce((total, item) => total + item.internalTotal, 0),
  );
  const equipmentProfit = roundCurrency(pricing.equipmentCustomerPrice - equipmentInternalCost);

  const internalCost = roundCurrency(
    garbageFee +
      miscellaneousFee +
      pricing.supplyCost +
      truckInternalCost +
      laborInternalCost +
      equipmentInternalCost,
  );

  return {
    truckInternalCost,
    laborInternalCost,
    equipmentInternalCost,
    equipmentProfit,
    internalCost,
    overallProfit: roundCurrency(pricing.customerPrice - internalCost),
    equipment,
  };
}

/** Pricing and internal figures together — for holders, and for the saved snapshot. */
export function calculateJob(
  input: JobCalculationInput,
  rates: CalculatorRates = defaultCalculatorRates(),
): JobCalculationResult {
  const pricing = calculateCustomerPricing(input, rates);
  const internal = calculateInternalFigures(input, pricing);
  const internalByKey = new Map(internal.equipment.map((item) => [item.key, item]));
  const { equipment: pricedEquipment, ...customer } = pricing;
  const { equipment: _internalEquipment, ...costs } = internal;
  return {
    ...customer,
    ...costs,
    equipment: pricedEquipment.map((item) => {
      const cost = internalByKey.get(item.key)!;
      return {
        ...item,
        internalRate: cost.internalRate,
        internalTotal: cost.internalTotal,
        profit: cost.profit,
      };
    }),
  };
}

/** A structural whitelist: private values never enter the PDF input object. */
export function toCustomerCalculation(input: JobCalculationInput, result: CustomerPricing) {
  return {
    jobDate: input.jobDate,
    customerName: input.customerName,
    contactNumber: input.contactNumber,
    email: input.email,
    address: input.address,
    addressLine2: input.addressLine2,
    locality: input.locality,
    region: input.region,
    postalCode: input.postalCode,
    jobType: input.jobType,
    days: nonNegative(input.days),
    workers: nonNegative(input.workers),
    emergency: input.emergency,
    laborPrice: result.laborCustomerPrice,
    suppliesPrice: result.supplyCost,
    truckPrice: result.truckCustomerPrice,
    garbageFee: nonNegative(input.garbageFee),
    miscellaneousFee: nonNegative(input.miscellaneousFee),
    equipment: result.equipment
      .filter((item) => item.quantity > 0 && item.customerTotal > 0)
      .map(({ key, label, unit, quantity, customerRate, customerTotal }) => ({
        key,
        label,
        unit,
        quantity,
        customerRate,
        customerTotal,
      })),
    customerPrice: result.customerPrice,
  };
}

export type CustomerCalculation = ReturnType<typeof toCustomerCalculation>;
