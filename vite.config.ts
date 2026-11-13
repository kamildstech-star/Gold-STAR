// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";
import { bundleSecretScan } from "./src/lib/security/bundle-secret-plugin";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    /*
     * Off Lovable on Vercel only: `npm run build:vercel` sets NITRO_PRESET=vercel,
     * and every other build, Lovable's included, gets no `nitro` key at all.
     * (This is Vite's own `nitro` option, read by nitro/vite; the wrapper's
     * top-level `nitro` option stays unset.) Nitro's Node presets leave some
     * packages outside the bundle and copy them in by tracing. tslib is one,
     * and the tslib alias below makes the tracer copy only tslib.es6.js, so
     * Node's own resolution of `tslib` found no modules/index.js and every
     * server route 500'd. Bundling everything, as the Workers build already
     * does, keeps the alias and the module graph Lovable runs, and leaves no
     * node_modules in the function to go wrong.
     */
    ...(process.env.NITRO_PRESET === "vercel" ? { nitro: { noExternals: true } } : {}),
    resolve: {
      alias: {
        /*
         * pdf-lib depends on tslib 1.x and reaches for its CommonJS build. On
         * Cloudflare Workers the ESM interop hands back an undefined default,
         * so pdf-lib's first line - `const { __extends } = tslib` - throws
         * while the worker is still starting, and EVERY route 500s, including
         * "/". Pointing tslib at its own ES-module build makes __extends a
         * real named export.
         */
        tslib: "tslib/tslib.es6.js",
      },
    },
    plugins: [
      // The security review: nothing but the anon key and URL is public by
      // design. This fails the build if a service-role key, a secret key
      // format or a server secret's value is in what ships to browsers.
      bundleSecretScan(),
      // Field users lose signal in basements and stairwells. The generated
      // worker caches static assets; private page navigation requires a
      // connection. src/lib/offline-queue.ts preserves work in an open app.
      VitePWA({
        /*
         * "prompt", not "autoUpdate": a new worker waits until the person taps
         * Reload on the "Update available" toast (register-sw.ts). autoUpdate
         * was a no-op here anyway — the plugin only sets skipWaiting/clientsClaim
         * for it when it also injects the registration, and ours is hand-rolled
         * (injectRegister: null) — so a new build sat waiting until every tab
         * closed, which on a phone running the installed app is roughly never.
         */
        registerType: "prompt",
        filename: "sw.js",
        /*
         * Without this the plugin writes to its own default, `dist/`, while
         * nitro serves `.output/public` — so `/sw.js` 404'd in production, the
         * registration in register-sw.ts silently failed, and the app had no
         * offline shell at all. It also globbed an empty `dist/`, which is why
         * the build log read "precache 0 entries".
         *
         * Off Lovable on Vercel (`npm run build:vercel`, which sets
         * NITRO_PRESET=vercel), nitro's static directory is the Build Output
         * API's `.vercel/output/static` instead, and the same two failures
         * return there unless the worker is written and globbed in it. Every
         * other build — Lovable's included — is unchanged.
         */
        outDir: process.env.NITRO_PRESET === "vercel" ? ".vercel/output/static" : ".output/public",
        injectRegister: null,
        devOptions: { enabled: false },
        manifest: false,
        workbox: {
          // Explicit, because the plugin's defaults depend on registerType and
          // injectRegister together. skipWaiting stays off so the toast is
          // the only way a new worker takes over; clientsClaim is on so that
          // when it does, the open page hears `controllerchange` and reloads.
          skipWaiting: false,
          clientsClaim: true,
          globPatterns: ["**/*.{js,css,ico,png,svg,woff2}"],
          /*
           * No SPA fallback: this is a server-rendered app with no index.html.
           * Left at its default the plugin emits
           * `createHandlerBoundToURL("index.html")`, which throws
           * `non-precached-url` the moment the worker script is evaluated —
           * every registration failed, register-sw.ts swallowed the rejection,
           * and production ran with no worker at all (verified 2026-09-17 by
           * evaluating the built sw.js). Navigations are NetworkOnly below.
           */
          navigateFallback: null,
          runtimeCaching: [
            {
              urlPattern: ({ request }: { request: Request }) => request.mode === "navigate",
              // Never retain SSR or token-bearing pages in a shared browser.
              // Cache Storage ignores Cache-Control and survives sign-out.
              handler: "NetworkOnly",
            },
            {
              urlPattern: ({ request, url }: { request: Request; url: URL }) =>
                url.origin === self.location.origin &&
                // `/api/documents/$id/file` is a same-origin image request for
                // every photo document, and CacheFirst would park per-user,
                // RLS-gated bytes in Cache Storage for a month — where a later
                // user of the same browser would be served them. Cache Storage
                // does not honour `no-store`; the exclusion has to be here.
                !url.pathname.startsWith("/api/") &&
                ["style", "script", "font", "image"].includes(request.destination),
              handler: "CacheFirst",
              options: {
                cacheName: "static-assets",
                expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
