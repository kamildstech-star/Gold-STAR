import * as React from "react";
import { Copy, ExternalLink, Printer } from "lucide-react";
import { toast } from "sonner";

import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { prizeMoney, raffleEntryUrl, type Raffle, type RafflePrize } from "@/lib/raffles";

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * A letter-size poster for the booth: the prize, a QR code you can scan from
 * two metres, and the short URL for anyone whose camera will not. Built as a
 * standalone page in a new window so the app's layout never prints with it.
 */
function printPoster(
  raffle: Raffle,
  prizes: RafflePrize[],
  showName: string,
  url: string,
  qrSvg: string,
) {
  const w = window.open("", "_blank", "width=850,height=1100");
  if (!w) {
    toast.error("Allow pop-ups for this site to print the poster.");
    return;
  }
  const prizeList = prizes
    .map(
      (p, i) =>
        `<li><span class="rank">${prizes.length > 1 ? (["1st", "2nd", "3rd"][i] ?? `${i + 1}th`) : "Prize"}</span>` +
        `<span class="name">${esc(p.name)}${p.quantity > 1 ? ` <small>× ${p.quantity}</small>` : ""}</span>` +
        `${p.value ? `<span class="val">${esc(prizeMoney(p.value))}</span>` : ""}</li>`,
    )
    .join("");
  w.document
    .write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(raffle.title)}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; background: #fff; }
  .p { display: flex; flex-direction: column; align-items: center; text-align: center; min-height: 9.8in; padding: 0.2in 0.3in; border: 6px solid #b8860b; border-radius: 24px; }
  img.logo { height: 70px; margin-top: 8px; }
  .show { margin-top: 14px; font-size: 16px; letter-spacing: .12em; text-transform: uppercase; color: #555; font-weight: 600; }
  h1 { margin: 8px 0 4px; font-size: 52px; line-height: 1.05; font-weight: 900; }
  .head { font-size: 22px; color: #333; margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 0 0 18px; width: 100%; max-width: 6in; }
  li { display: flex; align-items: center; gap: 12px; border: 2px solid #eee; border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; font-size: 22px; }
  .rank { font-size: 13px; font-weight: 800; text-transform: uppercase; color: #fff; background: #b8860b; border-radius: 999px; padding: 4px 10px; }
  .name { flex: 1; text-align: left; font-weight: 700; }
  .val { font-weight: 700; color: #444; }
  small { font-weight: 500; color: #666; }
  .qr svg { width: 3.6in; height: 3.6in; }
  .cta { font-size: 34px; font-weight: 900; margin: 10px 0 2px; }
  .url { font-size: 13px; color: #555; word-break: break-all; }
  .fine { margin-top: auto; font-size: 11px; color: #777; max-width: 6.5in; }
</style></head><body><div class="p">
  <img class="logo" src="${location.origin}/gold-star-logo.png" alt="Gold Star Restoration" />
  <div class="show">${esc(showName)}</div>
  <h1>${esc(raffle.title)}</h1>
  ${raffle.headline ? `<p class="head">${esc(raffle.headline)}</p>` : ""}
  ${prizeList ? `<ul>${prizeList}</ul>` : ""}
  <div class="qr">${qrSvg}</div>
  <div class="cta">Scan to enter</div>
  <div class="url">${esc(url)}</div>
  <div class="fine">One entry per person. No purchase necessary. Full rules on the entry page.</div>
</div><script>window.onload=function(){setTimeout(function(){window.print()},250)}</script></body></html>`);
  w.document.close();
}

export function RaffleQrDialog({
  raffle,
  prizes,
  showName,
  open,
  onClose,
}: {
  raffle: Raffle;
  prizes: RafflePrize[];
  showName: string;
  open: boolean;
  onClose: () => void;
}) {
  const url = raffleEntryUrl(raffle.token);
  const holder = React.useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{raffle.title}</DialogTitle>
          <DialogDescription>
            Visitors scan this to open the entry form. Print the poster for the booth, or show this
            screen on a tablet.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div ref={holder}>
            <QrCode value={url} size={288} title={`Enter ${raffle.title}`} />
          </div>
          <div className="flex w-full gap-2">
            <Input
              readOnly
              value={url}
              className="h-9 text-[12px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              variant="outline"
              className="h-9"
              title="Copy link"
              onClick={() => {
                void navigator.clipboard.writeText(url);
                toast.success("Link copied");
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button
              onClick={() =>
                printPoster(raffle, prizes, showName, url, holder.current?.innerHTML ?? "")
              }
            >
              <Printer className="mr-1.5 size-4" /> Print poster
            </Button>
            <Button variant="outline" asChild>
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-1.5 size-4" /> Open form
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
