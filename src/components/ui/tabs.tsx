import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

/*
 * Two looks for a tab strip (3 Nov redesign). "segmented" — the default — is
 * the job page's: tabs sit in one muted track and the open one is filled in
 * the palette's primary with its paired ink (4 Nov: "make it color not
 * white"); every palette sets that pair for AA, light and dark. "line" is the older underline strip, kept for a caller that
 * styles its own underline. The list tells its triggers which one it is.
 */
type TabsVariant = "segmented" | "line";
const TabsVariantContext = React.createContext<TabsVariant>("segmented");

const Tabs = TabsPrimitive.Root;

const LIST: Record<TabsVariant, string> = {
  segmented:
    "inline-flex h-auto items-center justify-start gap-1 rounded-xl border bg-muted p-1 text-muted-foreground",
  line: "inline-flex h-9 items-center justify-start gap-3 rounded-none border-b bg-transparent p-0 text-muted-foreground touch:h-auto touch:min-h-11",
};

const TRIGGER: Record<TabsVariant, string> = {
  segmented:
    "h-8 gap-2 rounded-lg px-3 text-[13px] font-medium hover:bg-card/60 hover:text-foreground data-[state=active]:bg-primary data-[state=active]:font-semibold data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm [&_svg]:size-4 touch:h-11",
  line: "rounded-none border-b-2 border-transparent bg-transparent px-1 pb-1.5 pt-1 text-[13px] font-medium hover:text-foreground data-[state=active]:border-link data-[state=active]:bg-transparent data-[state=active]:text-link data-[state=active]:font-semibold [&_svg]:size-3.5 touch:px-2",
};

const SCROLL_ON_PHONE =
  "max-md:flex max-md:w-full max-md:overflow-x-auto max-md:overscroll-x-contain max-md:no-scrollbar";
const TRIGGER_BASE =
  "group/tab inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:shrink-0";

/*
 * The same look for a strip that is not a Radix Tabs (a filter row of
 * buttons with role="tab"): the list takes TAB_STRIP and each button takes
 * TAB_TRIGGER plus `data-state={on ? "active" : "inactive"}`.
 */
export const TAB_STRIP = cn(LIST.segmented, SCROLL_ON_PHONE);
export const TAB_TRIGGER = cn(TRIGGER_BASE, TRIGGER.segmented, "max-md:shrink-0");

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = "segmented", ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      data-variant={variant}
      className={cn(
        LIST[variant],
        // Below md a six-tab strip is wider than the phone and used to widen the
        // whole page with it. Scroll the strip, not the document. `no-scrollbar`
        // because a permanent bar under a 36px tab row is all noise.
        SCROLL_ON_PHONE,
        className,
      )}
      {...props}
    />
  </TabsVariantContext.Provider>
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        TRIGGER_BASE,
        TRIGGER[variant],
        // A tab must not shrink to nothing inside the scrolling strip — a
        // squeezed tab is a miss for a finger.
        "max-md:shrink-0",
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/** A small count beside a tab's label; tinted while its tab is open. */
function TabsCount({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground group-data-[state=active]/tab:bg-primary-foreground/15 group-data-[state=active]/tab:text-primary-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsCount };
