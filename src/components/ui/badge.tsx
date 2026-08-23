import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
  {
    variants: {
      tone: {
        critical: "bg-sev-critical/15 text-sev-critical",
        high: "bg-sev-high/15 text-sev-high",
        medium: "bg-sev-medium/15 text-sev-medium",
        low: "bg-sev-low/15 text-sev-low",
        muted: "bg-surface-2 text-muted",
        accent: "bg-accent/15 text-accent",
        cyan: "bg-cyan/15 text-cyan",
      },
    },
    defaultVariants: { tone: "muted" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone, className }))} {...props} />;
}
