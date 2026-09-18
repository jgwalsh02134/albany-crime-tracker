import { useEffect, useState } from "react";
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
  const size = className ?? "size-11";

  useEffect(() => {
    setOk(true);
  }, [id]);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white p-0.5 ring-1 ring-black/10 shadow-sm dark:ring-white/10",
        size,
      )}
      title={label}
    >
      {ok ? (
        <img
          src={`/seals/${id}.png?v=97`}
          alt=""
          className="size-full object-contain"
          decoding="async"
          loading="lazy"
          onError={() => setOk(false)}
        />
      ) : (
        <span
          className="flex size-full items-center justify-center rounded-full bg-surface-2 text-muted"
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.3 3.6 2.9 18.4A2 2 0 0 0 4.7 21h14.6a2 2 0 0 0 1.8-2.6L13.7 3.6a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
      )}
    </span>
  );
}
