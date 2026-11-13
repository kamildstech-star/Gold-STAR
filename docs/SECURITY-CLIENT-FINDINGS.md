# Goldstar client/browser and file-handling audit

Date: 2026-09-07. Workspace: `C:/dev/goldstar-security-audit`.
Read `AGENTS.md`. No commits, pushes, database writes, or live email sends were performed.

## Confirmed findings fixed

| Severity | Finding and original trigger | Fix / evidence |
| --- | --- | --- |
| High | Stored XSS in `src/components/token-editor.tsx`: saved email template HTML and unescaped job merge values reached `innerHTML`. An image with an `onerror` handler could execute when staff opened the template. Token highlighting also rewrote tokens inside attributes. | `src/lib/safe-html.ts` uses DOMPurify with a formatting-tag and URL allowlist. Editor loads, clipboard HTML, emitted values and outgoing rich email are sanitized; drops are blocked. Highlighting walks text nodes; merge values are escaped before substitution in `job-email-dialog.tsx:203`. Malicious markup, encoded script URLs, attribute tokens, repeated highlighting, mounted editor loading and paste insertion have regression tests. |
| Medium | Plain-text email bodies were interpolated as HTML in `email-composer.tsx`, `quick-composer.tsx` and `document-send-dialog.tsx`. Template/customer text could inject markup and misleading links into outgoing mail. This finding does not assume recipients execute scripts. | Shared `textToEmailHtml` escapes text before adding paragraphs/line breaks. Tests verify tags remain literal text and intended paragraph/line breaks survive. Rich emails also receive a final sanitizer pass. |
| Medium | `compliance-files.tsx` embedded every non-image upload in an unrestricted iframe. HTML/XHTML could run active content inside the preview. Storage is a separate origin; direct access to the app's origin was not demonstrated. | `SafeFilePreview` only embeds a raster-image allowlist or sandboxed PDF. HTML, SVG, XHTML, unknown types are not embedded. Metadata spoofed as PDF still receives an empty sandbox. An always-visible Download PDF button fetches an inert octet-stream blob and downloads it without navigating to uploaded content. Rendering and download-path tests pass. Native PDF plugin display was not browser-smoke-tested; the explicit fallback addresses blank viewers. |
| Medium | `receipt-pdf.ts:189` printed the office's free-form payment notes on a customer receipt, alongside payment details. | Removed that output. Upgraded `document-audience.test.ts` to render an actual receipt, verify a legitimate reference remains, and inspect decompressed PDF text for internal-note sentinels. The previous receipt test swallowed render failures and only inspected query strings. |
| Medium | `esx.ts` bounded only compressed file size after downloading. ZIP expansion, nested ZIPXML deflate/zlib streams and the incoming response body were unbounded. | Limit download and aggregate expanded ZIP bytes to 64 MiB; each archive member/nested decoded stream to 8 MiB; member count to 1,024. ZIP metadata is checked before expansion and nested decompression uses fixed output buffers with an overflow sentinel. Downloads with oversized declared or streamed lengths are cancelled. Regression fixtures cover highly compressed oversized XML, nested deflate, member count, declared download size, and successful ordinary XML parsing. This bounds output memory, not a guarantee of constant CPU time. |

## Coverage and boundaries

- Searched `src/components` and eligible `src/lib` sources for raw HTML sinks, `srcDoc`, dynamic execution, browsing contexts, object URLs, environment references, server imports and generated-email interpolation. Changes are confined to components, HTML/file/PDF helpers, their tests and dependency manifests.
- Inspected template editing/sending, assistant Markdown, compliance previews, document viewer classification/URLs, generated PDF preview/printing, estimate/invoice/receipt/customer-calculator PDFs, photo/PDF helpers, ESX parsing, chart style generation, map pins and credential-management UI. This is targeted sink/data-flow coverage, not an assertion that every component received exhaustive manual review.
- Estimate/invoice audience filtering already suppresses cost/margin for customer output; calculator PDFs use a customer projection. Existing sentinel tests for these protections passed. Internal print/download copies intentionally retain internal financial columns; manual redistribution of those copies is outside this fix.
- Contract body rendering writes text into PDF operations, not browser HTML. SVG upload exclusion in general document classification and React-escaped text/ESX display were already present. Assistant Markdown does not enable raw HTML. Chart styles consume developer configuration; map pin content uses fixed colors and a numeric unit count. No additional exploitable XSS path was confirmed there.
- Component source scanning found no direct `.server` imports or embedded private credential values. Browser environment references reviewed are publishable Supabase configuration, the Maps browser key/tracking ID and Turnstile site key. Credential UI calls metadata/server functions and uses password inputs for private edits. This is source-level coverage only: no production bundle was built or searched by this audit task; no claim of complete secret-leak exclusion is made.
- Coordinated with the parallel owner of `register-sw`, Vite, server and security-response files: general document viewing opens `/api/documents/:id/file` in a PDF object or a new tab; same-origin HTML/SVG response MIME/disposition safety belongs to that owner. Auth, graph, intake, `*functions.ts` and `assistant*.server` were not edited. Other agents' shared-workspace changes were preserved.
- No live user accounts, stored customer files, browser PDF plugins, external mail delivery or database policies were exercised. Sanitizer/DOM tests use jsdom and synthetic fixtures; PDF tests inspect actual generated bytes. Large legitimate ESX members above the new limits now require opening in a desktop tool.

## Dependencies and verification

- Added runtime `dompurify@3.4.15` (`^3.4.15`) and development `jsdom@30.0.1` (`^30.0.1`); `package-lock.json` updated. Both install-time npm audits reported zero vulnerabilities. The coordinating review regenerated `bun.lock` from the tested npm lockfile and verified frozen-lock compatibility.
- Focused suite: **72 tests passed across 11 files**: `safe-html.test.ts`, `safe-html.ssr.test.ts`, `token-editor.test.tsx`, `safe-file-preview.test.tsx`, `safe-file-download.test.ts`, `document-audience.test.ts`, `pdf-kit.test.ts`, `photo-pdf.test.ts`, `job-calculator.test.ts`, `payment-receipt.test.ts`, `esx-security.test.ts`.
- Node SSR test explicitly imports the DOMPurify-dependent helper without `window`, verifies escaping, and verifies rich HTML fails closed. Receipt PDF generation also passes in the default Node test environment.
- Scoped ESLint: zero errors; four Fast Refresh warnings about mixed component/helper exports (three existing TokenEditor patterns and the download helper).
- Final `npx tsc --noEmit`: passed (exit 0), including the typed anchor selector that fixes the reported `Element.protocol` test error.
- Scoped `git diff --check` passed.

## Changed-file ownership

Components: `compliance-files.tsx`, `document-send-dialog.tsx`, `email-composer.tsx`, `job-email-dialog.tsx`, `quick-composer.tsx`, `token-editor.tsx`, new `safe-file-preview.tsx`, and three new component test files.

Libraries: new `safe-html.ts` and two test files, `receipt-pdf.ts`, `document-audience.test.ts`, `esx.ts`, new `esx-security.test.ts`.

Other: `package.json`, `package-lock.json`, this findings report. Temporary `SECURITY-CLIENT-OWNERSHIP.md` is removed at handoff.
