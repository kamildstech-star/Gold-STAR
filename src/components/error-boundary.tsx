import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Generic widget-level error boundary. A crashing widget renders its own
 * fallback instead of blanking the whole route.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label?: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? "widget"}] render failed`, error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      this.props.fallback ?? (
        <div className="grid h-full min-h-[120px] place-items-center rounded-xl border bg-muted/30 p-4 text-center text-[12px] text-muted-foreground">
          This section couldn’t be displayed.
        </div>
      )
    );
  }
}

/** Boundary tuned for map surfaces — keeps the panel's own sizing. */
export function MapBoundary({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ErrorBoundary
      label="map"
      fallback={
        <div
          className={
            "grid place-items-center rounded-xl border bg-muted/30 p-4 text-center text-[12px] text-muted-foreground " +
            (className ?? "")
          }
        >
          Map unavailable.
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
