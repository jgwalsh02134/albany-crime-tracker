import { createServerFn } from "@tanstack/react-start";
import { wireToIncidents } from "./sources";

const MAX_PROMPT = 800;
const MAX_HISTORY = 8;

type ChatTurn = { role: "user" | "assistant"; content: string };

async function snapshot(): Promise<string> {
  const now = Date.now();
  const { fetchLiveWire } = await import("./live-sources");
  const wire = await fetchLiveWire();
  const all = wireToIncidents(wire.items);
  const byMuni = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const i of all) {
    byMuni.set(i.municipality, (byMuni.get(i.municipality) ?? 0) + 1);
    byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
  }
  const muni = [...byMuni.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([n, c]) => `${n} ${c}`)
    .join(", ");
  const types = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([n, c]) => `${n} ${c}`)
    .join(", ");
  const lines = all.slice(0, 50).map((i) => {
    const mins = Math.round((now - new Date(i.occurredAt).getTime()) / 60000);
    return `- ${i.severity.toUpperCase()} | ${i.title} | ${i.municipality} | ${mins}m ago | ${i.agency} | ${i.sources[0]?.kind ?? ""}`;
  });
  const health = wire.health
    ? `Official blotter ${wire.health.blotter}, scanner ${wire.health.scanner}, 511 ${wire.health.traffic}, news ${wire.health.news}, Facebook ${wire.health.facebook ?? 0}, X ${wire.health.x ?? 0}, citizens ${wire.health.reddit ?? 0}.`
    : "";
  return `Live Capital District activity (NYSP blotter through ~7 AM ET, plus scanner captions, 511 crashes, department Facebook/X, citizen reports, breaking news). ${all.length} items. ${health}\nTowns: ${muni || "none"}\nTypes: ${types || "none"}\n${lines.join("\n") || "(none right now)"}`;
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
              "You are the Albany County Crime Tracker assistant. Answer only about public-safety activity in the Capital District, NY. The snapshot mixes official NYSP blotter calls, unconfirmed scanner captions, 511 crashes, department Facebook/X posts, citizen/Reddit reports, and newsroom headlines. Treat blotter/511 and official department Facebook as official. Treat scanner, Reddit, and citizen tips as unconfirmed. Treat newsroom items as journalism, not CAD. Never invent arrests, names of victims, or charges that are not in the snapshot. If asked something off-topic, steer back to county public safety.",
          },
          {
            role: "system",
            content: await snapshot(),
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
