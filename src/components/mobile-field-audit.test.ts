import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "make sure the app works on mobile"
 *
 * The phone-width audit of the field flows (Oct 2026). Each guard cuts out the
 * fragment it is about — never the whole file, so the explanatory comments
 * beside each fix cannot satisfy or break it.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("the job page at phone width", () => {
  const JOB = read("src/routes/_authenticated/jobs.$id.tsx");

  it("scrolls the element that actually overflows to bring the active tab into view", () => {
    // Below md the TabsList is the scroller, not the wrapper div.
    const effect = JOB.match(/const tabStripRef = useRef[\s\S]*?\}, \[tab, loading\]\);/)![0];
    expect(effect).toContain(`querySelector<HTMLElement>('[role="tablist"]')`);
    expect(effect).toMatch(/list\.scrollWidth > list\.clientWidth \? list : wrapper/);
    expect(effect).toMatch(/strip\.scrollLeft \+=/);
  });

  it("bleeds the sticky tab row by the page's own gutter, not past it", () => {
    const row = JOB.match(/ref=\{tabPinRef\}\s*className="([^"]*)"/)![1];
    expect(row).toMatch(/(^| )-mx-2( |$)/);
    expect(row).toMatch(/(^| )px-2( |$)/);
    expect(row).toContain("sm:-mx-4");
    expect(row).not.toMatch(/(^| )-mx-4( |$)/);
  });

  it("pins only the tab strip, at every width (3 Nov: the money cards sit above it)", () => {
    const header = JOB.match(/ref=\{headerRef\}[\s\S]*?className="([^"]*)"/)![1].split(" ");
    expect(header).toEqual(["contents"]);

    const row = JOB.match(/ref=\{tabPinRef\}\s*className="([^"]*)"/)![1].split(" ");
    for (const c of ["sticky", "top-0", "z-30", "bg-background/95"]) {
      expect(row).toContain(c);
    }
    // space-y-3 cannot reach through display:contents, so the row keeps the gap.
    expect(row).toContain("mb-3");
  });

  it("measures whichever box actually sticks for the header offset", () => {
    const effect = JOB.match(/const \[headerH, setHeaderH\][\s\S]*?\}, \[loading\]\);/)![0];
    expect(effect).toMatch(/getComputedStyle\(el\)\.display === "contents" \? row : el/);
    expect(effect).toMatch(/ro\.observe\(tabPinRef\.current\)/);
  });

  it("orders the tabs by role and fades the edge that has more", () => {
    const strip = JOB.match(/<div\s+ref=\{tabStripRef\}[\s\S]*?<\/TabsList>/)![0];
    expect(strip).toMatch(/tabOrder\.map\(\(t\) =>/);
    expect(strip).toMatch(/className="edge-fade /);
    expect(strip).toMatch(/data-fade-start=\{tabFade\.start \|\| undefined\}/);
    expect(strip).toMatch(/data-fade-end=\{tabFade\.end \|\| undefined\}/);
    // No hard-coded trigger left behind to escape the order.
    expect(strip).not.toMatch(/<TabsTrigger value="/);
    // In role order; Timeline and Timecard sit behind "More" (3 Nov meeting).
    expect(JOB).toMatch(/const allTabs = jobTabOrder\(app\.primary\);/);
    expect(JOB).toMatch(
      /const tabOrder = allTabs\.filter\(\(t\) => !JOB_TABS_IN_MORE\.includes\(t\)\);/,
    );
    const fade = JOB.match(/const \[tabFade, setTabFade\][\s\S]*?\}, \[loading\]\);/)![0];
    expect(fade).toMatch(/addEventListener\("scroll", update, \{ capture: true/);
    expect(fade).toMatch(/stripFade\(strip\)/);
  });

  it("defines the edge fade as a mask that only exists when an edge has more", () => {
    const CSS = read("src/styles.css");
    // From the utility's opening brace to the end of its second mask declaration.
    const util = CSS.match(
      /@utility edge-fade \{[\s\S]*?mask-image:[\s\S]*?[^-]mask-image:[^;]*;/,
    )![0];
    expect(util).toMatch(/&:is\(\[data-fade-start\], \[data-fade-end\]\) \{/);
    expect(util).toMatch(/-webkit-mask-image: linear-gradient\(/);
    expect(util).toMatch(/[^-]mask-image: linear-gradient\(/);
  });

  it("bleeds the header's badge row by the page gutter, not 16px past an 8px one", () => {
    const SRC = read("src/components/job-header.tsx");
    const row = SRC.match(/<div className="(no-scrollbar mt-[^ ]+ [^"]*)">/)![1].split(" ");
    expect(row).toEqual(expect.arrayContaining(["max-md:-mx-2", "max-md:px-2", "sm:max-md:-mx-4"]));
    expect(row).not.toContain("max-md:-mx-4");
  });
});

describe("the Equipment tab header", () => {
  it("wraps its three buttons instead of widening the page", () => {
    const SRC = read("src/components/equipment-panel.tsx");
    const header = SRC.match(
      /<CardHeader className="([^"]*)">\s*<CardTitle className="text-base">Equipment on this job/,
    )![1];
    expect(header).toContain("flex-wrap");
    const group = SRC.match(/Equipment on this job<\/CardTitle>\s*<div className="([^"]*)">/)![1];
    expect(group).toContain("flex-wrap");
  });
});

describe("the document viewer's header at phone width", () => {
  const SRC = read("src/components/document-viewer.tsx");
  const header = SRC.match(/<DialogHeader className="([^"]*)">/)![1];
  // Everything between the title block and the end of the header.
  const toolbar = SRC.match(/<DialogHeader[\s\S]*?<\/DialogHeader>/)![0];
  const strip = toolbar.match(
    /<\/div>\s*<\/div>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div className="([^"]*)">/,
  )![1];

  it("stacks the toolbar under the title until lg instead of squeezing the title to nothing", () => {
    expect(header).toContain("flex-col");
    expect(header).toContain("lg:flex-row");
    expect(header).not.toMatch(/(^| )flex-row( |$)/);
    // shrink-0 only where the two sit side by side; below that it wraps.
    expect(strip).toContain("flex-wrap");
    expect(strip).toContain("lg:shrink-0");
    expect(strip).not.toMatch(/(^| )shrink-0( |$)/);
  });

  it("keeps the pager and Download out on a phone", () => {
    const pager = toolbar.match(/pdfPages > 1 && \(\s*<div className="([^"]*)"/)![1];
    expect(pager).not.toMatch(/(^| )hidden( |$)/);
    const download = toolbar.match(
      /className="([^"]*)"\s*asChild\s*onClick=\{\(\) => void logDocumentEvent\(doc\.id, "downloaded"\)\}/,
    )![1];
    expect(download).not.toMatch(/(^| )hidden( |$)/);
    // An <a> dressed as a button misses the global 44px touch floor.
    expect(download).toContain("touch:h-11");
    expect(download).toContain("touch:min-w-11");
  });

  it("folds zoom, rotate and New tab into a More menu below sm", () => {
    const zoom = toolbar.match(/\{zoomable && \(\s*<div className="([^"]*)"/)![1];
    expect(zoom).toMatch(/(^| )hidden( |$)/);
    expect(zoom).toContain("sm:flex");
    const rotate = toolbar.match(/className="([^"]*)"\s*aria-label="Rotate"/)![1];
    expect(rotate).toContain("hidden");
    expect(rotate).toContain("sm:inline-flex");
    const newTab = toolbar.match(
      /<Button size="sm" variant="ghost" className="([^"]*)" asChild>/,
    )![1];
    expect(newTab).toContain("hidden");
    expect(newTab).toContain("sm:inline-flex");

    const trigger = toolbar.match(/className="([^"]*)"\s*aria-label="More actions"/)![1];
    expect(trigger).toContain("sm:hidden");
    const menu = toolbar.match(/<DropdownMenuContent[\s\S]*?<\/DropdownMenuContent>/)![0];
    for (const call of ["zoomIn()", "zoomOut()", "resetZoom", "rotate()"]) {
      expect(menu, call).toContain(call);
    }
    expect(menu).toContain("Open in a new tab");
    expect(menu).toContain("href={fileUrl}");
  });
});

describe("no invisible buttons on a touch screen", () => {
  it("shows the note delete on touch", () => {
    const SRC = read("src/components/job-section-notes.tsx");
    const btn = SRC.match(/className="([^"]*)"\s*aria-label="Remove note"/)![1];
    expect(btn).toContain("touch:opacity-100");
  });

  it("shows the notice edit and dismiss on touch", () => {
    const SRC = read("src/components/job-notices.tsx");
    // 3 Nov: the actions sit at the right of each banner and are always shown,
    // so nothing is hidden behind a hover a phone does not have.
    const bubble = SRC.slice(
      SRC.indexOf("function NoticeBubble"),
      SRC.indexOf("function InlineEditor"),
    );
    expect(bubble).toContain("aria-label={`Dismiss ");
    expect(bubble).not.toMatch(/opacity-0/);
  });
});

describe("thumb-sized links", () => {
  it("gives Call, Text and Email on the job rail a 44px target on touch", () => {
    const SRC = read("src/components/job-side-rail.tsx");
    // The Button whose child is a tel:, sms: or mailto: link.
    const anchors = [
      ...SRC.matchAll(
        /className="([^"]*)"\s+asChild\s*>(?:\s*\{\/\*[\s\S]*?\*\/\})?\s*<a href=\{`(tel|sms|mailto):/g,
      ),
    ];
    expect(anchors.map((m) => m[2]).sort()).toEqual(["mailto", "sms", "tel"]);
    for (const m of anchors) expect(m[1], m[2]).toContain("touch:h-11");
  });
});

describe("sticky bars clear the phone bottom nav", () => {
  /*
   * Every bar here is `sticky` inside the app shell's <main>, the scroll
   * container. Below md, <main> already reserves
   * pb-[calc(4rem+env(safe-area-inset-bottom,0px))] for the fixed bottom nav,
   * and a sticky element is held inside its scroll container's padding edge —
   * so `bottom-0` already docks a bar on top of the nav (7px clear at 375px,
   * the nav being 57px against 64px of padding), and the padding carries the
   * notch inset the nav grows by.
   *
   * `above-mobile-nav` adds 4rem from the bottom on top of that: it is for
   * something positioned against the VIEWPORT (`fixed`). On these bars it
   * counted the nav twice — measured in a copy of the shell at 375px, each
   * floated 71px clear of the nav with page content showing underneath. #278
   * put it on the Jobs pager without measuring. Do not put it back.
   */
  const SHELL = read("src/components/app-shell.tsx");
  const classesOf = (src: string, re: RegExp) => re.exec(src)![1]!.split(/\s+/);

  it("the shell still reserves the nav's height on <main>, which is what bottom-0 relies on", () => {
    expect(SHELL).toContain('"pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0"');
  });

  it("parks the Jobs pager at sticky bottom-0 — not above-mobile-nav, not a hard 54px", () => {
    const SRC = read("src/routes/_authenticated/jobs.index.tsx");
    const bar = classesOf(SRC, /<div className="(sticky [^"]*)">/);
    expect(bar).toContain("bottom-0");
    expect(bar).not.toContain("above-mobile-nav");
    expect(bar).not.toContain("bottom-[54px]");
  });

  it("docks the estimate sheet's totals bar at sticky bottom-0", () => {
    const SRC = read("src/components/estimate-sheet.tsx");
    const bar = classesOf(SRC, /<div className="([^"]*\bsticky\b[^"]*\bborder-t\b[^"]*)">/);
    expect(bar).toContain("sticky");
    expect(bar).toContain("bottom-0");
    expect(bar).not.toContain("above-mobile-nav");
  });

  it("docks the job calculator's page bar at sticky bottom-0 (the dialog one already was)", () => {
    const SRC = read("src/components/job-calculator-editor.tsx");
    // The ternary that picks the action bar's classes: dialog first, page second.
    const choice = SRC.match(/embedded\s*\?\s*"([^"]*\bsticky\b[^"]*)"\s*:\s*"([^"]*)"/)!;
    const dialog = choice[1]!.split(/\s+/);
    const page = choice[2]!.split(/\s+/);
    expect(dialog).toContain("bottom-0");
    expect(page).toContain("sticky");
    expect(page).toContain("bottom-0");
    expect(page).not.toContain("above-mobile-nav");
  });

  /*
   * The root cause. The utility's own comment used to call it the offset for
   * "a page's own sticky action bar", and four sticky bars inside <main> were
   * written to that instruction and floated. The comment now says fixed-only;
   * these keep it saying so, and keep the class off sticky bars.
   */
  it("documents above-mobile-nav as for fixed elements only, never sticky bars inside <main>", () => {
    const CSS = read("src/styles.css");
    const at = CSS.indexOf("@utility above-mobile-nav {");
    expect(at).toBeGreaterThan(-1);
    const comment = CSS.slice(CSS.lastIndexOf("/*", at), at);
    expect(comment).toMatch(/element `fixed` to the viewport/);
    expect(comment).toMatch(/NOT for a `sticky` bar inside <main>/);
    expect(comment).toMatch(/`sticky bottom-0`/);
    expect(comment).not.toMatch(/sticky action bar/i);
  });

  it("puts above-mobile-nav only on class lists that are fixed, never sticky", () => {
    // Every component and route, so the fifth bar is caught wherever it lands.
    const files = (readdirSync("src", { recursive: true }) as string[])
      .map((f) => `src/${String(f).replace(/\\/g, "/")}`)
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      for (const m of read(f).matchAll(/"([^"\n]*\babove-mobile-nav\b[^"\n]*)"/g)) {
        const cls = m[1]!.split(/\s+/);
        expect(cls, `${f}: ${m[1]}`).toContain("fixed");
        expect(cls, `${f}: ${m[1]}`).not.toContain("sticky");
      }
    }
  });

  it("keeps the job photo selection bar at sticky bottom-2 — not above-mobile-nav", () => {
    /*
     * The bar is sticky inside the app shell's <main>, the scroll container,
     * and <main> already carries pb-[calc(4rem+env(safe-area-inset-bottom))]
     * below md: the room the fixed bottom nav covers. A sticky element is held
     * inside the scroll container's padding edge, so `bottom-2` already parks
     * the bar a few pixels above the nav. `above-mobile-nav` (4rem) stacks a
     * second nav-height on top of that padding — measured at 375px in a copy
     * of the shell, it left a 72px gap with photos showing under the bar.
     * The utility is for something positioned against the VIEWPORT; this bar
     * is positioned against <main>. Do not "fix" it back.
     */
    const SHELL = read("src/components/app-shell.tsx");
    expect(SHELL).toContain('"pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0"');
    const SRC = read("src/components/job-photos.tsx");
    const start = SRC.indexOf("{selectMode && (");
    expect(start).toBeGreaterThan(-1);
    const bar = SRC.slice(start)
      .match(/<div className="([^"]*sticky[^"]*)"/)![1]
      .split(/\s+/);
    expect(bar).toContain("sticky");
    expect(bar).toContain("bottom-2");
    expect(bar).not.toContain("above-mobile-nav");
  });

  it("leaves the drying log's Log readings bar at bottom-2, where <main>'s padding already clears the nav", () => {
    const SRC = read("src/components/job-drying-log.tsx");
    const bar = SRC.match(
      /<div className="([^"]*)">\s*<Button\s+className="h-12 w-full shadow-lg"\s+onClick=\{save\}/,
    )![1];
    // A sticky box sticks inside its scroller's padding, and <main> already
    // pads 4rem for the nav. above-mobile-nav on top of that floats the bar
    // 70px up with the readings showing beneath it (measured, Chrome, 360px).
    expect(bar).toMatch(/(^| )bottom-2( |$)/);
    expect(bar).not.toContain("above-mobile-nav");
  });
});

describe("the drying log's small controls", () => {
  const SRC = read("src/components/job-drying-log.tsx");

  it("gives the saved meter photo a 44px target under a finger", () => {
    const fn = SRC.match(/function SavedMeterPhoto\([\s\S]*?\n}\n/)![0];
    const link = fn.match(/<a[\s\S]*?className="([^"]*)"/)![1];
    expect(link).toContain("touch:size-11");
    expect(link).toContain("inline-flex");
  });

  it("gives the water selects the box's full width, never a fixed one", () => {
    // 11 Nov (client): each label above its dropdown; the dropdown spans the
    // box and stays a 44px target on a phone.
    for (const label of ["Water category", "Water class"]) {
      const trigger = SRC.match(
        new RegExp(`<SelectTrigger\\s+className="([^"]*)"\\s+aria-label="${label}"`),
      )![1];
      expect(trigger).toContain("w-full");
      expect(trigger).toContain("h-11");
      expect(trigger).not.toMatch(/(^| )w-\[13\.5rem\]/);
    }
  });
});

describe("the field work ticket on a phone", () => {
  const SRC = read("src/components/field-work-ticket-panel.tsx");

  it("lets Same as last ticket wrap instead of scrolling the dialog sideways", () => {
    const btn = SRC.match(/className="([^"]*)"\s*onClick=\{repeatLast\}/)![1];
    expect(btn).toContain("whitespace-normal");
    expect(btn).toContain("h-auto");
    expect(btn).toContain("min-h-11");
  });

  it("offers Take a photo and Choose a file for the paper ticket, not a raw file input", () => {
    const dialog = SRC.match(
      /<DialogTitle>Upload a paper ticket<\/DialogTitle>[\s\S]*?<\/DialogContent>/,
    )![0];
    expect(dialog).not.toMatch(/<Input[^>]*type="file"/);
    const pickers = [...dialog.matchAll(/<FilePick([\s\S]*?)\/>/g)].map((m) => m[1]);
    expect(pickers).toHaveLength(2);
    expect(pickers.some((p) => p.includes('capture="environment"'))).toBe(true);
    for (const p of pickers) expect(p).toContain("onPick={pickScan}");
    // The read still starts from the same file.
    expect(SRC).toMatch(/const pickScan = \(file: File\) => \{\s*setScanFile\(file\);/);
  });

  it("pins Save ticket to the bottom of the dialog", () => {
    const footer = SRC.match(/<DialogFooter className="([^"]*)">\s*<span[^>]*>\s*<CloudOff/)![1];
    // -bottom-6 because the dialog's p-6 is inside the sticky rectangle:
    // at bottom-0 the form showed through a 24px strip beneath the bar.
    for (const c of ["sticky", "-bottom-6", "bg-background", "-mx-6", "-mb-6"]) {
      expect(footer, c).toContain(c);
    }
    // And the dialog has to be flex: in the primitive's grid, the footer's
    // containing block is its own grid row and it cannot stick at all.
    const content = SRC.match(
      /<DialogContent className="([^"]*)">\s*<DialogHeader>\s*<DialogTitle>\s*\{reviewRead/,
    )![1];
    expect(content).toContain("flex-col");
    expect(content).toMatch(/(^| )flex( |$)/);
  });
});

describe("the asset-tag scanner on a phone", () => {
  const SRC = read("src/components/asset-tag-scanner.tsx");

  it("pins Confirm to the bottom of the dialog, in one row", () => {
    const footer = SRC.match(/<DialogFooter className="([^"]*)">\s*<Button variant="ghost"/)![1];
    for (const c of ["sticky", "-bottom-6", "bg-background", "flex-row"]) {
      expect(footer, c).toContain(c);
    }
    // Other props may follow the class (onOpenAutoFocus, 22 Oct); the layout is the class.
    const content = SRC.match(/<DialogContent\s+className="([^"]*)"[^>]*>\s*<DialogHeader>/)![1];
    expect(content).toContain("flex-col");
    expect(content).toMatch(/(^| )flex( |$)/);
  });

  it("asks twice before Clear wipes the scanned list", () => {
    const clear = SRC.match(/export function ClearScanned\([\s\S]*?\n}\n/)![0];
    // The first press only arms it; the second clears.
    expect(clear).toMatch(
      /if \(!armed\) \{\s*setArmed\(true\);\s*return;\s*\}\s*setArmed\(false\);\s*onClear\(\);/,
    );
    // A changed list disarms it, so the count it asked about is the count that goes.
    expect(clear).toMatch(/useEffect\(\(\) => \{\s*setArmed\(false\);\s*\}, \[count\]\);/);
    // Both lists use it; neither clears on one press any more.
    const list = SRC.match(/unit\{picked\.length === 1 \? "" : "s"\} scanned[\s\S]*?<\/div>/)![0];
    expect(list).toContain("<ClearScanned");
    expect(list).not.toContain("onClick={() => setPicked([])}");
    const PANEL = read("src/components/equipment-panel.tsx");
    const pickup = PANEL.match(/accounted for[\s\S]*?<\/div>/)![0];
    expect(pickup).toContain("<ClearScanned");
    expect(pickup).not.toMatch(/onClick=\{\(\) => scanned\.forEach/);
  });

  it("stacks the hour meter under its label below sm", () => {
    const HM = read("src/components/hour-meter-field.tsx");
    const label = HM.match(/<label className="([^"]*)">/)![1];
    expect(label).toContain("flex-col");
    expect(label).toContain("sm:flex-row");
    const input = HM.match(/<Input\s+className="([^"]*)"/)![1];
    expect(input).toContain("w-full");
    expect(input).not.toMatch(/(^| )flex-1( |$)/);
  });
});

describe("the time clock on a phone", () => {
  const SRC = read("src/routes/_authenticated/timeclock.index.tsx");

  it("puts Clock in / Clock out above the KPI tiles below md", () => {
    const root = SRC.match(
      /return \(\s*<div className="([^"]*)">\s*<PageHeader title="Time clock"/,
    )![1];
    // order only works in a flex container; space-y would not reorder.
    expect(root).toContain("flex");
    expect(root).toContain("flex-col");
    const strip = SRC.match(/<MetricStrip\s+className="([^"]*)"/)![1];
    expect(strip).toBe("max-md:order-1");
    // This week and the footer note follow the strip, not the other way round.
    expect(SRC).toMatch(
      /<Card className="max-md:order-2">\s*<CardHeader[^>]*>\s*<CardTitle[^>]*>This week/,
    );
  });
});

describe("phone navigation", () => {
  it("gives every role, field roles included, a Menu cell into the sidebar", () => {
    const SHELL = read("src/components/app-shell.tsx");
    const nav = SHELL.match(/function MobileBottomNav\([\s\S]*?\n}\n/)![0];
    const markup = nav.slice(nav.indexOf("return (\n    <nav"));
    // The label goes through the language switch (BC-LANG-1).
    expect(markup).toContain('<span>{t("Menu")}</span>');
    expect(markup).not.toMatch(/\{!mobileFirst && \(/);
  });

  it("shows the install banner on each role's home, not only the dashboard", () => {
    const SRC = read("src/components/install-prompt.tsx");
    const paths = SRC.match(/INSTALL_BANNER_PATHS: readonly string\[\] = (\[[^\]]*\])/)![1];
    expect(JSON.parse(paths)).toEqual(["/", "/chase"]);
  });
});

describe("the sign-in page on a small phone", () => {
  it("sizes to the small viewport and shrinks the logo below sm", () => {
    const AUTH = read("src/routes/auth.tsx");
    const page = AUTH.match(/function AuthPage\(\)[\s\S]*?\n}\n/)![0];
    expect(page).toContain('className="flex min-h-svh flex-col bg-muted/30"');
    expect(page).toMatch(/alt="Gold Star Restoration"\s*className="h-16 w-auto sm:h-24"/);
  });
});

describe("the job Contacts tab on a phone", () => {
  const SRC = read("src/components/job-contacts-tab.tsx");

  it("adds people through the one Add contact form (4 Nov: no inline row)", () => {
    // The inline name / email / phone row is gone; Add contact opens the full
    // form, whose own phone and email fields carry the keyboards.
    expect(SRC).not.toContain("data-job-contact-entry");
    expect(SRC).toMatch(/data-job-contact-add[\s\S]{0,120}Add contact/);
  });

  it("gives the inline phone edit a tel input too", () => {
    const ROW = read("src/components/row-inline-field.tsx");
    const type = ROW.match(/type=\{\s*kind === "date"[\s\S]*?\}\s*inputMode=\{([^}]*)\}/)!;
    expect(type[0]).toMatch(/kind === "phone"\s*\?\s*"tel"/);
    expect(type[1]).toMatch(/kind === "phone" \? "tel"/);
  });

  it("names every icon-only button", () => {
    const remove = SRC.match(/<Button([^>]*?)onClick=\{\(\) => void remove\(r\.id\)\}/)![1];
    expect(remove).toMatch(/aria-label=\{`Remove /);
    const star = SRC.match(/<Button([^>]*?)onClick=\{\(\) => void setDefault\(r\.id\)\}/)![1];
    expect(star).toContain("aria-label=");
  });
});

describe("New job on a phone", () => {
  const SRC = read("src/routes/_authenticated/jobs.new.tsx");

  it("pins Cancel and Create job to the bottom of the scroller", () => {
    const bar = SRC.match(
      /<div className="([^"]*)">\s*<Button\s+variant="outline"\s+onClick=\{\(\) => \{\s*\/\/ Cancel is/,
    )![1];
    expect(bar).toContain("sticky");
    expect(bar).toMatch(/(^| )bottom-0( |$)/);
    expect(bar).toContain("bg-background");
    // <main> already pads 4rem for the nav; a second 4rem would float it.
    expect(bar).not.toContain("above-mobile-nav");
  });

  it("keeps the draft and the related contacts it saves", () => {
    // #269 and #263 landed in this file today; the bar must not have cost them.
    expect(SRC).toMatch(/forgetDraft\(\);\s*navigate\(\{ to: "\/jobs"/);
    expect(SRC).toMatch(/const related = \[/);
  });
});

describe("the invoice's payment detail on a phone", () => {
  const SRC = read("src/components/job-billing-panel.tsx");
  const history = SRC.match(/function PaymentHistory\([\s\S]*?\n}\n/)![0];

  it("lays the seven columns out as cards below md", () => {
    expect(history).toContain("<Table cards>");
    for (const label of ["Amount", "Method", "Reference", "Photo", "Recorded by"]) {
      expect(history, label).toContain(`data-label="${label}"`);
    }
  });

  it("puts the note on its own card and keeps the desktop note row off the phone", () => {
    expect(history).toMatch(/<TableCell data-label="Note" className="[^"]*md:hidden[^"]*">/);
    // The card rules are unlayered, so only an important utility hides a row.
    expect(history).toMatch(/<TableRow className="max-md:hidden!">\s*<TableCell colSpan=\{7\}/);
  });
});

describe("removing a note can be undone", () => {
  const SRC = read("src/components/job-section-notes.tsx");
  const remove = SRC.match(/const remove = \(id: string\) => \{[\s\S]*?\n  \};/)![0];

  it("hides the note and holds the delete behind an Undo toast", () => {
    expect(remove).toMatch(/setRemoving\(\(prev\) => new Set\(prev\)\.add\(id\)\)/);
    expect(remove).toMatch(/undoableDelete\(\{/);
    expect(remove).toMatch(/label: "Undo"/);
    expect(remove).toMatch(/job\.undo\(\)/);
    expect(remove).toMatch(/onAutoClose: settle/);
    expect(remove).toMatch(/onDismiss: settle/);
  });

  it("sends the delete only from inside the held commit", () => {
    const deletes = [...SRC.matchAll(/from\("job_section_notes"\)\.delete\(\)/g)];
    expect(deletes).toHaveLength(1);
    const commit = remove.match(/commit: async \(\) => \{[\s\S]*?\n      \},/)![0];
    expect(commit).toMatch(/from\("job_section_notes"\)\.delete\(\)\.eq\("id", id\)/);
  });

  it("filters held notes out of what is drawn", () => {
    expect(SRC).toMatch(
      /const notes = \(q\.data \?\? \[\]\)\.filter\(\(n\) => !removing\.has\(n\.id\)\);/,
    );
  });

  it("sends whatever is held when the page goes hidden, since sonner pauses its clock", () => {
    const flush = SRC.match(/const flush = \(\) => \{[\s\S]*?\n    \};/)![0];
    expect(flush).toMatch(/document\.visibilityState !== "hidden"/);
    expect(flush).toMatch(/job\.settle\(\)/);
    expect(SRC).toMatch(/document\.addEventListener\("visibilitychange", flush\)/);
  });
});

describe("every Button gets the touch tap target, whatever it renders as", () => {
  it("marks the Button primitive with data-slot, before the caller's props", () => {
    const SRC = read("src/components/ui/button.tsx");
    const comp = SRC.match(/<Comp\s+([\s\S]*?)\/>/)![1];
    expect(comp).toMatch(/^data-slot="button"/);
    expect(comp.indexOf('data-slot="button"')).toBeLessThan(comp.indexOf("{...props}"));
  });

  it("extends the coarse-pointer 44px rule to [data-slot=button]", () => {
    const CSS = read("src/styles.css");
    const block = CSS.match(
      /@media \(pointer: coarse\) \{\s*:where\(\s*button,[\s\S]*?\) \{\s*min-height: 44px;/,
    )![0];
    expect(block).toMatch(/\[data-slot="button"\]\s*\):not\(/);
    // The opt-out still applies to it.
    expect(block).toMatch(/\[data-touch-compact\] \*/);
  });
});

describe("small fixes from the phone-width audit", () => {
  it("lets the Communications role filter take the row on a phone", () => {
    const SRC = read("src/components/job-communications-tab.tsx");
    const row = SRC.match(/<div className="([^"]*)">\s*<Select value=\{roleFilter\}/)![1];
    expect(row.split(" ")).toContain("flex-wrap");
    const trigger = SRC.match(
      /<SelectTrigger className="([^"]*)">\s*<SelectValue placeholder="All relationships"/,
    )![1];
    expect(trigger.split(" ")).toEqual(expect.arrayContaining(["w-full", "sm:w-[220px]"]));
    expect(trigger.split(" ")).not.toContain("w-[220px]");
  });

  it("bleeds the time clock's sticky header by the page's own px-4", async () => {
    const SRC = read("src/routes/_authenticated/timeclock.index.tsx");
    const override = SRC.match(
      /<PageHeader\s+title="Time clock"[\s\S]*?className="([^"]*)"\s*\/>/,
    )![1];
    // What the browser actually gets once PageHeader merges it with its own base.
    const UI = read("src/components/ui-density.tsx");
    const base = UI.match(/"(sticky top-0 z-20 -mx-3 [^"]*)"/)![1];
    const { cn } = await import("@/lib/utils");
    const merged = cn(base, override).split(" ");
    expect(merged).toEqual(expect.arrayContaining(["-mx-4", "px-4", "sticky"]));
    expect(merged).not.toContain("-mx-3");
    expect(merged).not.toContain("px-3");
  });
});
