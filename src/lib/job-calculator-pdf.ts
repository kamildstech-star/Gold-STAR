import { drawBrandMark } from "@/lib/brand-logo";
import {
  BAND,
  CONTENT_W,
  GOLD,
  INK,
  MARGIN,
  MUTED,
  NAVY,
  Sheet,
  money,
  qty,
  type Col,
} from "@/lib/pdf-kit";
import { JOB_CALCULATOR_TYPE_LABEL, type CustomerCalculation } from "@/lib/job-calculator";

export type JobCalculatorPdfResult = {
  bytes: Uint8Array;
  filename: string;
  title: string;
};

function displayJobDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return `${month}/${day}/${year}`;
}

/**
 * Build the customer document from the public projection only. This function
 * cannot accidentally print cost or margin fields because its input type does
 * not contain them.
 */
export async function buildJobCalculatorPdf(
  calculation: CustomerCalculation,
  preparedAt = new Date(),
): Promise<JobCalculatorPdfResult> {
  const sheet = await Sheet.create("customer");

  await drawBrandMark(sheet, MARGIN, 110, 28, () => {
    sheet.text("GOLD STAR RESTORATION", MARGIN, sheet.y - 12, {
      size: 9,
      bold: true,
      color: GOLD,
    });
    sheet.y -= 40;
  });
  sheet.text("ESTIMATE", MARGIN, sheet.y, { size: 22, bold: true, color: NAVY });
  sheet.text(preparedAt.toLocaleDateString("en-US"), MARGIN, sheet.y + 2, {
    size: 9,
    color: MUTED,
    align: "right",
    width: CONTENT_W,
  });
  sheet.y -= 13;
  sheet.text(`${JOB_CALCULATOR_TYPE_LABEL[calculation.jobType]} service`, MARGIN, sheet.y, {
    size: 10,
    color: INK,
  });
  sheet.y -= 10;
  sheet.rule(NAVY, 1);

  sheet.sectionLabel("Customer and property");
  const customerLines = [
    `Job date: ${displayJobDate(calculation.jobDate)}`,
    calculation.customerName || "Customer name not provided",
    calculation.contactNumber,
    calculation.email,
  ].filter(Boolean);
  const addressLines = [
    calculation.address,
    calculation.addressLine2,
    [calculation.locality, calculation.region, calculation.postalCode].filter(Boolean).join(", "),
  ].filter(Boolean);
  const colWidth = (CONTENT_W - 20) / 2;
  const top = sheet.y - 12;
  let leftY = top;
  for (const line of customerLines) {
    for (const wrapped of sheet.wrap(line, 9, colWidth)) {
      sheet.text(wrapped, MARGIN, leftY, { size: 9 });
      leftY -= 12;
    }
  }
  let rightY = top;
  for (const line of addressLines) {
    for (const wrapped of sheet.wrap(line, 9, colWidth)) {
      sheet.text(wrapped, MARGIN + colWidth + 20, rightY, { size: 9 });
      rightY -= 12;
    }
  }
  sheet.y = Math.min(leftY, rightY) - 2;

  sheet.sectionLabel("Service summary");
  const serviceCols: Col[] = [
    { key: "item", label: "Service", width: CONTENT_W - 105 },
    { key: "amount", label: "Amount", width: 105, align: "right" },
  ];
  sheet.tableHeader(serviceCols);
  sheet.tableRow(serviceCols, {
    item: `Labor - ${qty(calculation.workers)} worker(s), ${qty(calculation.days)} day(s)${calculation.emergency ? ", emergency response" : ""}`,
    amount: money(calculation.laborPrice),
  });
  sheet.tableRow(serviceCols, {
    item: `${JOB_CALCULATOR_TYPE_LABEL[calculation.jobType]} supplies`,
    amount: money(calculation.suppliesPrice),
  });
  sheet.tableRow(serviceCols, { item: "Truck", amount: money(calculation.truckPrice) });
  if (calculation.garbageFee > 0) {
    sheet.tableRow(serviceCols, { item: "Garbage", amount: money(calculation.garbageFee) });
  }
  if (calculation.miscellaneousFee > 0) {
    sheet.tableRow(serviceCols, {
      item: "Miscellaneous",
      amount: money(calculation.miscellaneousFee),
    });
  }

  if (calculation.equipment.length > 0) {
    sheet.sectionLabel("Equipment");
    const equipmentCols: Col[] = [
      { key: "item", label: "Equipment", width: CONTENT_W - 170 },
      { key: "qty", label: "Qty", width: 45, align: "right" },
      { key: "rate", label: "Rate", width: 60, align: "right" },
      { key: "amount", label: "Amount", width: 65, align: "right" },
    ];
    sheet.tableHeader(equipmentCols);
    calculation.equipment.forEach((item, index) => {
      sheet.tableRow(
        equipmentCols,
        {
          item: `${item.label} (${item.unit})`,
          qty: qty(item.quantity),
          rate: money(item.customerRate),
          amount: money(item.customerTotal),
        },
        MARGIN,
        { zebra: index % 2 === 1 },
      );
    });
  }

  sheet.gap(12);
  sheet.box(MARGIN, sheet.y - 30, CONTENT_W, 38, BAND);
  sheet.text("CUSTOMER PRICE", MARGIN + 10, sheet.y - 15, {
    size: 10,
    bold: true,
    color: NAVY,
  });
  sheet.text(money(calculation.customerPrice), MARGIN + 10, sheet.y - 18, {
    size: 16,
    bold: true,
    color: NAVY,
    align: "right",
    width: CONTENT_W - 20,
  });
  sheet.y -= 38;

  sheet.gap(12);
  sheet.para(
    "This estimate summarizes the requested services and quantities. Final scope and pricing may change if site conditions or requested work change.",
    { size: 8, color: MUTED },
  );
  sheet.stampFooters(["Gold Star Restoration", "Customer estimate"]);

  const safeName = (calculation.customerName || "customer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return {
    bytes: await sheet.save(),
    filename: `estimate-${safeName || "customer"}.pdf`,
    title: `Estimate - ${calculation.customerName || "Customer"}`,
  };
}
