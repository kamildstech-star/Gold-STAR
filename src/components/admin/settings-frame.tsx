import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, PanelLeft } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  SETTINGS_SECTION_ICON,
  SettingsNav,
  SettingsSearch,
} from "@/components/admin/settings-nav";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SETTINGS_ROOT,
  groupSettingsPages,
  settingsBreadcrumb,
  type SettingsPage,
} from "@/lib/admin-settings";

/**
 * The settings hub frame — presentation only. `admin.tsx` decides what this
 * person may see and hands it in; this draws it.
 *
 * On a laptop (lg and up) a left rail lists every section with its pages beneath
 * and a search box on top; the page sits to its right under a breadcrumb.
 * Below lg — an iPad in portrait, a phone — the rail becomes a drawer opened
 * from the header, and the breadcrumb still says where you are. Nothing else
 * changes between the two: same list, same search, same URLs.
 *
 * Someone with a single page (sales leadership and Field permissions) gets
 * that page, not a hub: no rail, no drawer, no search, and the "Settings"
 * crumb is a label rather than a link to an index they cannot open.
 */
export function SettingsFrame({
  pages,
  searchable,
  path,
  canOpenRoot,
  children,
}: {
  /** Pages to list, already narrowed to what this person can open. */
  pages: readonly SettingsPage[];
  /** Pages search may return — the listed pages plus openable sub-pages. */
  searchable: readonly SettingsPage[];
  /** Current pathname; drives the breadcrumb and the active row. */
  path: string;
  /** Whether the hub index itself is open to this person. */
  canOpenRoot: boolean;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Route changes close the drawer even when the navigation came from a link
  // inside the page rather than from the drawer itself.
  useEffect(() => setDrawerOpen(false), [path]);

  // Table heads pin below this header, not under it. Its height changes with
  // the page's description, so it is measured rather than assumed.
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const crumb = settingsBreadcrumb(path);
  const current: SettingsPage | null = crumb ? crumb.trail[crumb.trail.length - 1] : null;
  const singlePage = pages.length === 1;
  const rootLinks = canOpenRoot && !singlePage;

  return (
    <div className="flex min-h-full">
      {singlePage ? null : (
        <aside
          aria-label="Settings navigation"
          className="hidden w-60 shrink-0 self-start border-r lg:sticky lg:top-0 lg:block lg:max-h-[calc(100dvh-var(--table-sticky-top,0px))] lg:overflow-y-auto"
        >
          <div className="px-3 pt-3">
            {/* The title links to the hub only for someone who may open it —
                a Sales Head with two pages gets the rail but not the hub. */}
            {canOpenRoot ? (
              <Link
                to={SETTINGS_ROOT.path}
                className="display-heavy block truncate text-[22px] leading-tight hover:text-primary"
              >
                {SETTINGS_ROOT.label}
              </Link>
            ) : (
              <span className="display-heavy block truncate text-[22px] leading-tight">
                {SETTINGS_ROOT.label}
              </span>
            )}
            <p className="mt-0.5 text-[12px] text-muted-foreground">Workspace administration</p>
          </div>
          <SettingsNav pages={pages} searchable={searchable} currentPath={path} className="p-3" />
        </aside>
      )}

      <div
        className="flex min-h-full min-w-0 flex-1 flex-col"
        style={
          headerHeight == null
            ? undefined
            : ({ "--table-sticky-top": `${headerHeight}px` } as CSSProperties)
        }
      >
        {/* One header for the whole settings area: where you are, on every page. */}
        <header
          ref={headerRef}
          className="sticky top-0 z-20 border-b bg-background px-3 py-2.5 md:px-4"
        >
          <div className="flex items-start gap-2">
            {singlePage ? null : (
              <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Open settings menu"
                  className="size-10 shrink-0 lg:hidden"
                  onClick={() => setDrawerOpen(true)}
                >
                  <PanelLeft className="size-4" />
                </Button>
                <SheetContent side="left" className="w-[min(20rem,88vw)] overflow-y-auto p-0">
                  <SheetHeader className="px-4 pb-1 pt-4 text-left">
                    <SheetTitle className="display-heavy text-[20px]">
                      {canOpenRoot ? (
                        <Link to={SETTINGS_ROOT.path} onClick={() => setDrawerOpen(false)}>
                          {SETTINGS_ROOT.label}
                        </Link>
                      ) : (
                        SETTINGS_ROOT.label
                      )}
                    </SheetTitle>
                    <SheetDescription className="text-[12px]">
                      Pick an area, or search for a screen by name or by what it holds.
                    </SheetDescription>
                  </SheetHeader>
                  <SettingsNav
                    pages={pages}
                    searchable={searchable}
                    currentPath={path}
                    onNavigate={() => setDrawerOpen(false)}
                    className="p-3"
                  />
                </SheetContent>
              </Sheet>
            )}

            <div className="min-w-0 flex-1">
              <Breadcrumb>
                <BreadcrumbList className="text-[12px] sm:gap-1.5">
                  <BreadcrumbItem>
                    {rootLinks && crumb ? (
                      <BreadcrumbLink asChild>
                        <Link to={SETTINGS_ROOT.path}>{SETTINGS_ROOT.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <span className={crumb ? undefined : "font-medium text-foreground"}>
                        {SETTINGS_ROOT.label}
                      </span>
                    )}
                  </BreadcrumbItem>
                  {crumb ? (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        {rootLinks ? (
                          <BreadcrumbLink asChild>
                            <Link to={SETTINGS_ROOT.path} hash={`section-${crumb.section.id}`}>
                              {crumb.section.label}
                            </Link>
                          </BreadcrumbLink>
                        ) : (
                          <span>{crumb.section.label}</span>
                        )}
                      </BreadcrumbItem>
                      {crumb.trail.map((p, i) => {
                        const last = i === crumb.trail.length - 1;
                        return (
                          <Fragment key={p.path}>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                              {last ? (
                                <BreadcrumbPage className="font-semibold">{p.label}</BreadcrumbPage>
                              ) : (
                                <BreadcrumbLink asChild>
                                  <Link to={p.path as string}>{p.label}</Link>
                                </BreadcrumbLink>
                              )}
                            </BreadcrumbItem>
                          </Fragment>
                        );
                      })}
                    </>
                  ) : null}
                </BreadcrumbList>
              </Breadcrumb>

              {current ? (
                <>
                  <h1 className="display-heavy mt-0.5 truncate text-[22px] leading-tight">
                    {current.label}
                  </h1>
                  <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
                    {current.description}
                  </p>
                </>
              ) : (
                <h1 className="display-heavy mt-0.5 truncate text-[22px] leading-tight">
                  {SETTINGS_ROOT.label}
                </h1>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 p-3 md:p-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * The front door of Settings: a search box and one card per section listing its
 * pages with a line on each. Someone who can open exactly one settings page is
 * sent to it; there is no hub to browse with one card.
 */
export function SettingsHubBody({
  pages,
  searchable,
}: {
  pages: readonly SettingsPage[];
  searchable: readonly SettingsPage[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const groups = groupSettingsPages(pages);

  useEffect(() => {
    if (pages.length === 1) void navigate({ to: pages[0].path as string, replace: true });
  }, [pages, navigate]);

  const searching = query.trim().length > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="max-w-xl">
        <SettingsSearch searchable={searchable} query={query} onQueryChange={setQuery} size="lg" />
      </div>

      {searching ? null : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const Icon = SETTINGS_SECTION_ICON[g.section.id];
            return (
              <Card key={g.section.id} id={`section-${g.section.id}`} className="scroll-mt-28">
                <CardContent className="p-3">
                  <div className="flex items-start gap-2.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-4.5" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="font-display text-[16px] font-semibold leading-tight">
                        {g.section.label}
                      </h2>
                      <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                        {g.section.blurb}
                      </p>
                    </div>
                  </div>
                  <ul className="-mx-1 mt-2.5 flex flex-col">
                    {g.pages.map((p) => (
                      <li key={p.path}>
                        <Link
                          to={p.path as string}
                          className="group flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold leading-tight group-hover:text-primary">
                              {p.label}
                            </span>
                            <span className="block truncate text-[12px] text-muted-foreground">
                              {p.description}
                            </span>
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 group-hover:text-primary" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
