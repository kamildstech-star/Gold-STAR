import * as React from "react";

import { encodeQr, qrSvgPath } from "@/lib/qr";
import { cn } from "@/lib/utils";

/**
 * A QR code as inline SVG. Black on white regardless of theme — a scanner
 * wants contrast, not brand colours — and `shape-rendering: crispEdges` so
 * the modules do not blur at print size.
 */
export function QrCode({
  value,
  size = 192,
  className,
  title,
}: {
  value: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const path = React.useMemo(() => {
    try {
      return qrSvgPath(encodeQr(value));
    } catch {
      return null;
    }
  }, [value]);
  if (!path) return null;
  return (
    <svg
      viewBox={`0 0 ${path.size} ${path.size}`}
      width={size}
      height={size}
      role="img"
      aria-label={title ?? "QR code"}
      className={cn("rounded-md bg-white", className)}
      shapeRendering="crispEdges"
    >
      {title ? <title>{title}</title> : null}
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
