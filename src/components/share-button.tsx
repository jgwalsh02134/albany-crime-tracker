import { useState, type MouseEvent } from "react";
import { Drawer } from "vaul";
import { Check, Copy, Facebook, MessageSquare, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  copyShareLink,
  facebookIntentUrl,
  sharePayload,
  smsIntentUrl,
  xIntentUrl,
  type SharePayload,
} from "@/lib/share";
import { cn } from "@/lib/utils";

type Props = {
  payload: SharePayload;
  className?: string;
  size?: "icon" | "icon-sm" | "default" | "sm";
  variant?: "ghost" | "secondary" | "outline" | "default";
  label?: string;
  stopPropagation?: boolean;
};

export function ShareButton({
  payload,
  className,
  size = "icon-sm",
  variant = "ghost",
  label,
  stopPropagation = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");

  async function onShare(e: MouseEvent) {
    if (stopPropagation) {
      e.preventDefault();
      e.stopPropagation();
    }
    const canNative =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      (!navigator.canShare || navigator.canShare({ title: payload.title, text: payload.text, url: payload.url }));

    if (canNative) {
      const result = await sharePayload(payload);
      if (result === "shared") {
        setNote("Shared");
        window.setTimeout(() => setNote(""), 1600);
        return;
      }
      if (result === "cancelled") return;
    }
    setOpen(true);
  }

  async function onCopy() {
    const ok = await copyShareLink(payload);
    setCopied(ok);
    setNote(ok ? "Link copied" : "Could not copy");
    window.setTimeout(() => {
      setCopied(false);
      setNote("");
      if (ok) setOpen(false);
    }, 1200);
  }

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={cn("shrink-0", className)}
        onClick={(e) => void onShare(e)}
        aria-label={label ?? "Share"}
        title={label ?? "Share"}
      >
        <Share2 className={size === "icon-sm" ? "size-4" : "size-5"} />
        {label && size !== "icon" && size !== "icon-sm" ? <span>{label}</span> : null}
      </Button>
      {note && !open ? (
        <span className="sr-only" role="status">
          {note}
        </span>
      ) : null}
      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-[60] bg-bg/70" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-[70] mx-auto flex max-h-[70dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 outline-none">
            <div className="mx-auto h-1.5 w-12 rounded-full bg-border" />
            <Drawer.Title className="mt-3 text-base font-semibold">Share</Drawer.Title>
            <p className="mt-1 line-clamp-3 text-sm text-muted">{payload.title}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void onCopy()}
                className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm font-medium"
              >
                {copied ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy link"}
              </button>
              <a
                href={xIntentUrl(payload)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm font-medium"
              >
                <span className="flex size-4 items-center justify-center text-xs font-bold">𝕏</span>
                Post on X
              </a>
              <a
                href={facebookIntentUrl(payload)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm font-medium"
              >
                <Facebook className="size-4" />
                Facebook
              </a>
              <a
                href={smsIntentUrl(payload)}
                className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm font-medium"
              >
                <MessageSquare className="size-4" />
                Text / SMS
              </a>
            </div>
            {note ? (
              <p className="mt-3 text-center text-xs text-subtle" role="status">
                {note}
              </p>
            ) : null}
            <Button variant="secondary" className="mt-4 w-full" onClick={() => setOpen(false)}>
              Close
            </Button>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
