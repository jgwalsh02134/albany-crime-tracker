import { useState } from "react";
import { cn } from "@/lib/utils";

export function Seal({
  id,
  label,
  className,
}: {
  id: string;
  label: string;
  className?: string;
}) {
  const [ok, setOk] = useState(true);
  const initials = initialsOf(label);
  const size = className ?? "size-11";
  if (!ok) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold tracking-wide text-muted",
          size,
        )}
        aria-hidden
      >
        {initials}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 p-0.5",
        size,
      )}
    >
      <img
        src={`/seals/${id}.png`}
        alt=""
        className="size-full object-contain"
        onError={() => setOk(false)}
      />
    </span>
  );
}

function initialsOf(label: string): string {
  const parts = label
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}
