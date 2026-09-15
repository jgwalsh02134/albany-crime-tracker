import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Fade = "bg" | "surface";

export function HScrollFade({
  children,
  className,
  scrollClassName,
  fade = "bg",
  fadeSizeClassName = "w-10",
  peepClassName = "pr-10",
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  scrollClassName?: string;
  fade?: Fade;
  fadeSizeClassName?: string;
  peepClassName?: string;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);

  function compute() {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const canScroll = max > 1;
    if (!canScroll) {
      setShowLeft(false);
      setShowRight(false);
      return;
    }
    const atLeft = el.scrollLeft <= 1;
    const atRight = el.scrollLeft >= max - 1;
    setShowLeft(!atLeft);
    setShowRight(!atRight);
  }

  useEffect(() => {
    compute();
    const el = ref.current;
    if (!el) return;

    const onScroll = () => compute();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => compute())
        : null;
    ro?.observe(el);

    const id = window.setTimeout(() => compute(), 0);
    return () => {
      window.clearTimeout(id);
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        aria-label={ariaLabel}
        className={cn(
          "overflow-x-auto overscroll-x-contain scrollbar-none",
          peepClassName,
          scrollClassName,
        )}
      >
        {children}
      </div>
      {showLeft ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0",
            fadeSizeClassName,
            "bg-gradient-to-r",
            fade === "surface" ? "from-surface" : "from-bg",
            "to-transparent",
          )}
        />
      ) : null}
      {showRight ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0",
            fadeSizeClassName,
            "bg-gradient-to-l",
            fade === "surface" ? "from-surface" : "from-bg",
            "to-transparent",
          )}
        />
      ) : null}
    </div>
  );
}

