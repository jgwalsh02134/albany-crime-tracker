/** In-process last-success / count per open pipe. Admin /ready only. */

export type PipeStat = {
  id: string;
  label: string;
  lastOkAt: number;
  lastFailAt: number;
  lastError: string;
  lastCount: number;
  ok: number;
  fail: number;
};

type PipeState = {
  pipes: Map<string, PipeStat>;
};

const g = globalThis as unknown as { __actPipes?: PipeState };

function state(): PipeState {
  if (!g.__actPipes) g.__actPipes = { pipes: new Map() };
  return g.__actPipes;
}

function row(id: string, label: string): PipeStat {
  const s = state();
  const existing = s.pipes.get(id);
  if (existing) {
    if (label && existing.label !== label) existing.label = label;
    return existing;
  }
  const created: PipeStat = {
    id,
    label,
    lastOkAt: 0,
    lastFailAt: 0,
    lastError: "",
    lastCount: 0,
    ok: 0,
    fail: 0,
  };
  s.pipes.set(id, created);
  return created;
}

export function recordPipeOk(id: string, label: string, count: number) {
  const p = row(id, label);
  p.lastOkAt = Date.now();
  p.lastCount = count;
  p.ok += 1;
}

export function recordPipeFail(id: string, label: string, err: string) {
  const p = row(id, label);
  p.lastFailAt = Date.now();
  p.lastError = (err || "error").slice(0, 160);
  p.fail += 1;
}

export function pipeHealth(): {
  id: string;
  label: string;
  lastOkAt?: string;
  lastFailAt?: string;
  lastError?: string;
  lastCount: number;
  ok: number;
  fail: number;
  ageSec: number;
}[] {
  return [...state().pipes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      label: p.label,
      lastOkAt: p.lastOkAt ? new Date(p.lastOkAt).toISOString() : undefined,
      lastFailAt: p.lastFailAt ? new Date(p.lastFailAt).toISOString() : undefined,
      lastError: p.lastError || undefined,
      lastCount: p.lastCount,
      ok: p.ok,
      fail: p.fail,
      ageSec: p.lastOkAt ? Math.round((Date.now() - p.lastOkAt) / 1000) : -1,
    }));
}
