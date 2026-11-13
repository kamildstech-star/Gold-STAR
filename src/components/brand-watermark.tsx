import { Droplet, Flame, Cloud, Bug, Biohazard, CloudLightning } from "lucide-react";

/**
 * Ambient watermark for the sidebar dead-area. Low-opacity gold marks that
 * evoke the service lines (water, mold, fire, smoke, storm, biohazard) without
 * competing with navigation. Non-interactive and hidden from AT.
 *
 * Values are intentionally hand-placed (not a grid) so it reads as texture,
 * not iconography. If a stakeholder wants it bolder, raise the opacity here.
 */
type Mark = {
  Icon: React.ElementType;
  top: string;
  left: string;
  size: number;
  rotate: number;
  opacity: number;
};

const MARKS: Mark[] = [
  { Icon: Droplet, top: "6%", left: "18%", size: 44, rotate: -14, opacity: 0.09 },
  { Icon: Flame, top: "22%", left: "62%", size: 56, rotate: 10, opacity: 0.11 },
  { Icon: Cloud, top: "38%", left: "12%", size: 62, rotate: -6, opacity: 0.07 },
  { Icon: Bug, top: "48%", left: "68%", size: 38, rotate: 22, opacity: 0.08 },
  { Icon: CloudLightning, top: "66%", left: "24%", size: 50, rotate: -18, opacity: 0.09 },
  { Icon: Biohazard, top: "78%", left: "60%", size: 46, rotate: 8, opacity: 0.1 },
  { Icon: Droplet, top: "88%", left: "30%", size: 30, rotate: 30, opacity: 0.07 },
];

export function BrandWatermark() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 top-1/3 overflow-hidden group-data-[collapsible=icon]:hidden"
    >
      {MARKS.map((m, i) => {
        const Icon = m.Icon;
        return (
          <Icon
            key={i}
            style={{
              position: "absolute",
              top: m.top,
              left: m.left,
              width: m.size,
              height: m.size,
              color: "var(--brand-gold)",
              /* Halved for the light ground — texture, never noise. */
              opacity: m.opacity * 0.45,
              transform: `rotate(${m.rotate}deg)`,
            }}
            strokeWidth={1.5}
          />
        );
      })}
    </div>
  );
}
