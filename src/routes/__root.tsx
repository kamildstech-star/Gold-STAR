import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";
import { DashboardSkinProvider } from "@/lib/dashboard-skin";
import { registerAppServiceWorker } from "@/lib/register-sw";
import { listenForInstallPrompt } from "@/lib/pwa-install";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-[17px] font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  const thrown = error instanceof Error ? error : new Error(String(error));
  useEffect(() => {
    reportLovableError(thrown, { boundary: "tanstack_root_error_component" });
  }, [thrown]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-[17px] font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-sm border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      /*
       * viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
       * anything but zero. Without it iOS letterboxes the page inside the
       * safe area and every inset the styles ask for is silently 0, so the
       * bottom nav sits under the home indicator. No maximum-scale and no
       * user-scalable=no: pinch-zoom stays, and the 16px input rule in
       * styles.css is what stops Safari zooming on focus.
       */
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Recovery Hub — Gold Star Restoration" },
      /*
       * Mark: "make this a web app with install feature for both apple and
       * android". iOS reads none of the manifest for an installed app — the
       * name, the full-screen mode and the icon all come from these tags and
       * the apple-touch-icon link below. Brand navy for the status bar on
       * both platforms (Android takes it from manifest theme_color; iOS 15+
       * takes it from this meta when the status-bar style is "default"), so
       * the bar reads as the same chrome as the sidebar rail.
       */
      { name: "theme-color", content: "#10243d" },
      /*
       * Both spellings. `apple-mobile-web-app-capable` is what iOS reads and
       * has for fifteen years; `mobile-web-app-capable` is the standards-track
       * name Chrome wants and warns about the absence of in the console. Same
       * meaning, and the Apple one cannot be dropped — iOS honours no other.
       */
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "Recovery Hub" },
      {
        name: "description",
        content:
          "Recovery Hub is Gold Star Restoration's internal CRM for insurance restoration sales, dispatch, and job tracking across every location.",
      },
      { property: "og:title", content: "Recovery Hub — Gold Star Restoration" },
      {
        property: "og:description",
        content:
          "Recovery Hub is Gold Star Restoration's internal CRM for insurance restoration sales, dispatch, and job tracking across every location.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Recovery Hub — Gold Star Restoration" },
      {
        name: "twitter:description",
        content:
          "Recovery Hub is Gold Star Restoration's internal CRM for insurance restoration sales, dispatch, and job tracking across every location.",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/da48c2aa-585c-43ff-b4b3-7169b1cdb253/id-preview-84494d32--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app-1785712401412.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/da48c2aa-585c-43ff-b4b3-7169b1cdb253/id-preview-84494d32--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app-1785712401412.png",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      // 180×180, opaque: iOS paints a transparent icon on black.
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },

      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  // The inline theme script sets class/style on <html> before hydration, so
  // React must not treat those attributes as a mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // App-shell worker so the cockpit still loads with no signal, and the
  // install listener so Chrome's beforeinstallprompt is caught wherever the
  // page was opened, not only once the shell has mounted.
  useEffect(() => {
    registerAppServiceWorker();
    listenForInstallPrompt();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DashboardSkinProvider>
          {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
          <Outlet />
          <Toaster position="top-right" richColors closeButton />
        </DashboardSkinProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
