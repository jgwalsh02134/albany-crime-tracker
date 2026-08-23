import { createServerFn } from "@tanstack/react-start";
import { hydrateIncidents, lastHours } from "./data";

const MAX_PROMPT = 800;
const MAX_HISTORY = 8;

type ChatTurn = { role: "user" | "assistant"; content: string };

function snapshot(): string {
  const now = Date.now();
  const all = hydrateIncidents(now);
  const day = lastHours(all, 24, now);
  const lines = day.slice(0, 18).map((i) => {
    const mins = Math.round((now - new Date(i.occurredAt).getTime()) / 60000);
    return `- ${i.severity.toUpperCase()} | ${i.title} | ${i.municipality} | ${mins}m ago | ${i.agencyAbbr} | via ${i.sources.map((s) => s.name).join(", ")}`;
  });
  const byArea = new Map<string, number>();
  for (const i of day) byArea.set(i.municipality, (byArea.get(i.municipality) ?? 0) + 1);
  const areas = [...byArea.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}:${c}`)
    .join(", ");
  return `Last 24h incidents (${day.length}):\n${lines.join("\n")}\nCounts by area: ${areas || "n/a"}`;
}

export const askCrimeAi = createServerFn({ method: "POST" })
  .validator((input: { prompt: string; history?: ChatTurn[] }) => {
    const prompt = String(input.prompt ?? "").trim().slice(0, MAX_PROMPT);
    const history = (input.history ?? []).slice(-MAX_HISTORY).map((t) => ({
      role: t.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(t.content ?? "").slice(0, 2000),
    }));
    return { prompt, history };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "AI is not available in this environment." };
    }
    if (!data.prompt) {
      return { ok: false as const, error: "Ask a question about Albany County." };
    }

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 700,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "You are the Albany County Crime Tracker assistant. Answer only about public-safety activity in Albany County, NY (city of Albany, Colonie, Bethlehem, Guilderland, Cohoes, Watervliet, hilltowns, and county sheriff/NYSP Troop G). Be precise, calm, and source-aware. Never invent arrests, names of victims, or charges that are not in the snapshot. If the snapshot is a composite intelligence set rather than a live CAD dump, say so briefly. Distinguish scanner traffic (unconfirmed) from blotter/news (higher confidence). Do not give tactical advice for committing crimes. If asked something off-topic, steer back to county public safety.",
          },
          {
            role: "system",
            content: snapshot(),
          },
          ...data.history,
          { role: "user", content: data.prompt },
        ],
      }),
    });

    if (!res.ok) {
      return { ok: false as const, error: `AI request failed (${res.status}). Try again.` };
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { ok: false as const, error: "Empty response from the model." };
    return { ok: true as const, text };
  });
