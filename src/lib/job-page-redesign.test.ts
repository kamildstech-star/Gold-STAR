import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * 3 Nov job page redesign — UI only. These pin the decisions the client made
 * on the mock-up so a later tidy-up does not quietly undo them.
 */
const PAGE = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
const HEADER = readFileSync("src/components/job-header.tsx", "utf8");
const STRIP = readFileSync("src/components/job-money-strip.tsx", "utf8");

const actions = PAGE.slice(
  PAGE.indexOf("const headerActions"),
  PAGE.indexOf("];", PAGE.indexOf("const headerActions")),
);

describe("the job header's actions", () => {
  it("drops Add contact — it only switched to the Contacts tab", () => {
    expect(actions).not.toContain('key: "add-contact"');
  });

  it("puts Directions and Upload receipt in the ⋯ menu, Dispatch crew as the primary", () => {
    const block = (key: string) => actions.slice(actions.indexOf(`key: "${key}"`)).split("},")[0];
    expect(block("directions")).toContain("overflow: true");
    expect(block("upload-receipt")).toContain("overflow: true");
    expect(block("dispatch-crew")).toContain("primary: true");
  });

  it("never hides the primary action in the menu", () => {
    expect(HEADER).toMatch(
      /const menuItems = items\.filter\(\(a\) => a\.overflow \|\| !a\.primary\)/,
    );
  });
});

describe("the money stat cards", () => {
  it("show on every tab — rendered outside any TabsContent", () => {
    const at = PAGE.indexOf("<JobMoneyStrip");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(PAGE.indexOf('<TabsContent value="general"'));
  });

  it("follow the same gate as the Amounts card: costs, then billing only, then nothing", () => {
    expect(PAGE).toMatch(/showMoney=\{showMoney\}/);
    expect(PAGE).toMatch(/showBilling=\{showBilling\}/);
    expect(STRIP).toMatch(/const stats: Stat\[\] = showMoney/);
    expect(STRIP).toMatch(/if \(stats\.length === 0\) return null;/);
  });
});

describe("the tab strip", () => {
  it("gives every tab an icon", () => {
    const icons = readFileSync("src/components/job-tab-icon.tsx", "utf8");
    expect(icons).toMatch(/Record<JobTab, LucideIcon>/);
    expect(PAGE).toContain("const Icon = JOB_TAB_ICON[t];");
  });
});

describe("the job page's look reaches every tab without changing other screens", () => {
  it("scales buttons, badges and tables by tokens whose fallbacks are the old sizes", () => {
    const button = readFileSync("src/components/ui/button.tsx", "utf8");
    expect(button).toContain("h-[var(--btn-h,2rem)]");
    expect(button).toContain("h-[var(--btn-sm-h,1.75rem)]");
    const badge = readFileSync("src/components/ui/badge.tsx", "utf8");
    expect(badge).toContain("text-[length:var(--badge-text,10px)]");
    expect(badge).toContain("[text-transform:var(--badge-case,uppercase)]");
    const table = readFileSync("src/components/ui/table.tsx", "utf8");
    expect(table).toContain("h-[var(--th-h,1.75rem)]");
    expect(table).toContain("h-[var(--td-h,2rem)]");
  });

  it("sets the new sizes only under the job page", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const block = css.slice(
      css.indexOf("[data-job-page] {"),
      css.indexOf("}", css.indexOf("[data-job-page] {")),
    );
    for (const token of ["--btn-h", "--btn-sm-h", "--badge-text", "--th-h", "--td-h"]) {
      expect(block, token).toContain(token);
    }
    expect(PAGE).toMatch(/data-job-page\s/);
  });

  it("frames the tabs that had no card of their own", () => {
    for (const tab of ["contacts", "communications", "tasks", "schedule", "drying"]) {
      expect(PAGE, tab).toContain(`<JobTabCard tab="${tab}">`);
    }
    // 5 Nov: the merged tabs are inner tabs of the tab they joined.
    for (const [home, inner] of [
      ["contacts", "communications"],
      ["contacts", "portal"],
    ]) {
      expect(PAGE, inner).toContain(`value={innerTab("${home}")}`);
      expect(PAGE, inner).toMatch(new RegExp(`key: "${inner}"`));
    }
    // 6 Nov: Tasks and Equipment are tabs of their own again.
    expect(PAGE).toContain('<TabsContent value="tasks"');
    expect(PAGE).toContain('<TabsContent value="equipment"');
    expect(PAGE).not.toMatch(/<JobSection\s+section="equipment"/);
    expect(PAGE).toMatch(/<JobSection\s+section="timeline"\s+defaultCollapsed/);
    expect(PAGE).toMatch(/<JobSection\s+section="timecard"/);
  });
});

describe("the redesign's pieces are the app's shared primitives", () => {
  const tabs = readFileSync("src/components/ui/tabs.tsx", "utf8");
  const alert = readFileSync("src/components/ui/alert.tsx", "utf8");
  const metric = readFileSync("src/components/metric-stat.tsx", "utf8");

  it("every tab strip is segmented unless a caller asks for the line", () => {
    expect(tabs).toMatch(/variant = "segmented"/);
    expect(tabs).toContain("export { Tabs, TabsList, TabsTrigger, TabsContent, TabsCount }");
  });

  it("alerts come in soft tones with foreground words", () => {
    for (const tone of ["info:", "success:", "warning:", "destructive:", "neutral:"]) {
      expect(alert, tone).toContain(tone);
    }
    expect(alert).toContain("text-foreground");
    expect(readFileSync("src/components/job-notices.tsx", "utf8")).toContain("ALERT_TONE.warning");
  });

  it("the job's money cards are MetricStat tiles, with the colour bar", () => {
    expect(STRIP).toContain("<MetricStat");
    expect(metric).toContain('"--kpi-accent": iconTint');
  });
});
