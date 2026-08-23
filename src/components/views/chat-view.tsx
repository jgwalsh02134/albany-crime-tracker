import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askCrimeAi } from "@/lib/chat";
import { cn } from "@/lib/utils";

type Msg = { id: string; role: "user" | "assistant"; content: string };

const STARTERS = [
  { label: "Last 48 hours", prompt: "What happened in Albany County in the last 48 hours?" },
  { label: "Risky areas", prompt: "Which neighborhoods should residents be cautious in right now, based on the snapshot?" },
  { label: "Crime stats", prompt: "Break down current activity by type and municipality." },
];

export function ChatView() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: "hello",
      role: "assistant",
      content:
        "Ask me about crime in Albany County. I can summarize the live feed, compare areas, and separate scanner traffic from confirmed reports.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setError(null);
    const user: Msg = { id: `u-${Date.now()}`, role: "user", content: text };
    setMessages((m) => [...m, user]);
    setInput("");
    setBusy(true);
    const history = [...messages, user]
      .filter((m) => m.id !== "hello")
      .map((m) => ({ role: m.role, content: m.content }));
    const res = await askCrimeAi({ data: { prompt: text, history } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: res.text }]);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto overscroll-y-contain px-4 py-3 scrollbar-thin">
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn("max-w-[90%] rounded-xl px-3 py-2.5 text-sm leading-relaxed", {
                "self-start rounded-bl-sm bg-surface border border-border": m.role === "assistant",
                "self-end rounded-br-sm bg-accent text-accent-fg": m.role === "user",
              })}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
          {busy ? (
            <div className="self-start rounded-xl border border-border bg-surface px-3 py-2 text-sm text-subtle">
              Reading the county snapshot…
            </div>
          ) : null}
        </div>
        {messages.length < 3 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => send(s.prompt)}
                className="h-8 rounded-full border border-border bg-surface px-3 text-xs font-medium text-muted"
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
        {error ? <p className="mt-3 text-sm text-sev-high">{error}</p> : null}
      </div>
      <form
        className="flex gap-2 border-t border-border bg-bg px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about Albany County…"
          aria-label="Ask the AI assistant"
          disabled={busy}
        />
        <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Send">
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}
