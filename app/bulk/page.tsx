"use client";

import { useState, useRef, useCallback } from "react";

interface Ticket {
  id: string;
  subject: string;
  body: string;
  customer_tier: string;
}

interface BulkResult {
  ticket_id: string;
  model: "sonnet" | "nano" | "super" | "routed";
  decision: {
    ticket_id: string;
    category: string;
    priority: string;
    confidence: number;
    reasoning: string;
    needs_human: boolean;
  };
  latencyMs: number;
  cost: number;
}

type ModelCol = "sonnet" | "nano" | "routed";

interface RowState {
  ticket: Ticket;
  sonnet: BulkResult | null;
  nano: BulkResult | null;
  routed: BulkResult | null;
  status: "waiting" | "done" | "error";
}

const MODEL_META: Record<ModelCol, { label: string; accent: string; accentDim: string }> = {
  sonnet: { label: "Sonnet 4.6", accent: "var(--sonnet-amber)", accentDim: "var(--sonnet-amber-dim)" },
  nano: { label: "Nemotron 3 Nano", accent: "var(--nano-green)", accentDim: "var(--nano-green-dim)" },
  routed: { label: "Routed", accent: "var(--routed-teal)", accentDim: "var(--routed-teal-dim)" },
};

export default function BulkPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [rows, setRows] = useState<RowState[]>([]);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error404, setError404] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Aggregate stats
  const [stats, setStats] = useState<Record<ModelCol, { totalCost: number; totalLatency: number; count: number }>>({
    sonnet: { totalCost: 0, totalLatency: 0, count: 0 },
    nano: { totalCost: 0, totalLatency: 0, count: 0 },
    routed: { totalCost: 0, totalLatency: 0, count: 0 },
  });

  const loadTickets = async () => {
    const res = await fetch("/api/tickets");
    const data: Ticket[] = await res.json();
    const limited = data.slice(0, 30);
    setTickets(limited);
    setRows(limited.map((t) => ({ ticket: t, sonnet: null, nano: null, routed: null, status: "waiting" })));
    setLoaded(true);
    setError404(false);
    setStats({
      sonnet: { totalCost: 0, totalLatency: 0, count: 0 },
      nano: { totalCost: 0, totalLatency: 0, count: 0 },
      routed: { totalCost: 0, totalLatency: 0, count: 0 },
    });
  };

  const runBulk = useCallback(async () => {
    if (!tickets.length) return;
    setRunning(true);
    setError404(false);
    setStats({
      sonnet: { totalCost: 0, totalLatency: 0, count: 0 },
      nano: { totalCost: 0, totalLatency: 0, count: 0 },
      routed: { totalCost: 0, totalLatency: 0, count: 0 },
    });
    // Reset rows
    setRows(tickets.map((t) => ({ ticket: t, sonnet: null, nano: null, routed: null, status: "waiting" })));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/triage/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickets }),
        signal: controller.signal,
      });

      if (res.status === 404) {
        setError404(true);
        setRunning(false);
        return;
      }

      if (!res.ok) {
        setError404(true);
        setRunning(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { setRunning(false); return; }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const result: BulkResult = JSON.parse(line);
            const col: ModelCol = result.model === "super" ? "routed" : result.model as ModelCol;

            setRows((prev) =>
              prev.map((row) => {
                if (row.ticket.id !== result.ticket_id) return row;
                const updated = { ...row, [col]: result };
                // Check if all columns filled
                const filledCount = (updated.sonnet ? 1 : 0) + (updated.nano ? 1 : 0) + (updated.routed ? 1 : 0);
                if (filledCount === 3) updated.status = "done";
                return updated;
              })
            );

            setStats((prev) => ({
              ...prev,
              [col]: {
                totalCost: prev[col].totalCost + result.cost,
                totalLatency: prev[col].totalLatency + result.latencyMs,
                count: prev[col].count + 1,
              },
            }));
          } catch {
            // Skip malformed lines
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError404(true);
    } finally {
      setRunning(false);
      // Mark remaining as done
      setRows((prev) => prev.map((r) => (r.status === "waiting" ? { ...r, status: "done" } : r)));
    }
  }, [tickets]);

  const avgLatency = (col: ModelCol) => stats[col].count > 0 ? Math.round(stats[col].totalLatency / stats[col].count) : 0;

  return (
    <div className="min-h-screen p-6 md:p-10 max-w-[1600px] mx-auto">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-2 rounded-full bg-[var(--nano-green)]" />
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--text-muted)] font-medium">
            Amazon Bedrock + NVIDIA Nemotron Workshop
          </span>
        </div>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Bulk Triage
        </h1>
        <p className="mt-2 text-[var(--text-secondary)] text-base max-w-2xl">
          Stream-classify tickets across three model configs. Build{" "}
          <code className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] font-[family-name:var(--font-mono)] text-xs text-[var(--nano-green)]">
            /api/triage/bulk
          </code>{" "}
          in Phase 2 to light this up.
        </p>
      </header>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          onClick={loadTickets}
          disabled={running}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all
            border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]
            hover:bg-[var(--bg-elevated)] active:scale-[0.98]
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Load 30 sample tickets
        </button>
        <button
          onClick={runBulk}
          disabled={!loaded || running}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all
            bg-[var(--nano-green)] text-[oklch(15%_0.01_145)]
            hover:brightness-110 active:scale-[0.98]
            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
        >
          {running ? "Running..." : "Run Bulk Triage"}
        </button>
        {loaded && (
          <span className="text-xs text-[var(--text-muted)]">
            {tickets.length} tickets loaded
          </span>
        )}
      </div>

      {/* 404 Empty State */}
      {error404 && (
        <div className="animate-snap-in rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 mb-6 text-center">
          <div className="text-4xl mb-3">🚧</div>
          <p className="text-lg font-semibold text-[var(--text-primary)] mb-2">
            /api/triage/bulk not found
          </p>
          <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
            Build it in Phase 2 and this table will light up. The endpoint should accept{" "}
            <code className="px-1 py-0.5 rounded bg-[var(--bg-deep)] font-[family-name:var(--font-mono)] text-xs">
              POST {"{"} tickets: Ticket[] {"}"}
            </code>{" "}
            and return NDJSON.
          </p>
        </div>
      )}

      {/* Table */}
      {loaded && !error404 && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--bg-elevated)]">
                <tr className="border-b border-[var(--border-subtle)]">
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium w-12">
                    #
                  </th>
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium min-w-[200px]">
                    Subject
                  </th>
                  {(["sonnet", "nano", "routed"] as ModelCol[]).map((col) => (
                    <th key={col} className="text-left px-4 py-3 min-w-[180px]">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: MODEL_META[col].accent }} />
                        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium">
                          {MODEL_META[col].label}
                        </span>
                      </div>
                    </th>
                  ))}
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium w-20">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <TableRow key={row.ticket.id} row={row} index={idx} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty table placeholder */}
      {!loaded && !error404 && (
        <div className="rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)] p-12 text-center">
          <p className="text-sm text-[var(--text-muted)]">
            Load sample tickets to populate the table
          </p>
        </div>
      )}

      {/* Footer Stats */}
      {loaded && (stats.sonnet.count > 0 || stats.nano.count > 0 || stats.routed.count > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          {(["sonnet", "nano", "routed"] as ModelCol[]).map((col) => (
            <div
              key={col}
              className="animate-snap-in rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5"
            >
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full" style={{ background: MODEL_META[col].accent }} />
                <span className="text-xs font-semibold text-[var(--text-primary)]">{MODEL_META[col].label}</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block">Cost</span>
                  <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[var(--text-primary)]">
                    ${stats[col].totalCost.toFixed(4)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block">Avg Latency</span>
                  <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[var(--text-primary)]">
                    {avgLatency(col).toLocaleString()}ms
                  </span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block">Processed</span>
                  <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[var(--text-primary)]">
                    {stats[col].count}/{tickets.length}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TableRow({ row, index }: { row: RowState; index: number }) {
  return (
    <tr
      className="border-b border-[var(--border-subtle)] last:border-b-0 animate-snap-in"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-xs text-[var(--text-muted)]">
        {row.ticket.id.replace("T-", "")}
      </td>
      <td className="px-4 py-3 text-[var(--text-secondary)] truncate max-w-[250px]" title={row.ticket.subject}>
        {row.ticket.subject}
      </td>
      {(["sonnet", "nano", "routed"] as ModelCol[]).map((col) => (
        <td key={col} className="px-4 py-3">
          <ModelCell result={row[col]} col={col} />
        </td>
      ))}
      <td className="px-4 py-3">
        <StatusBadge status={row.status} />
      </td>
    </tr>
  );
}

function ModelCell({ result, col }: { result: BulkResult | null; col: ModelCol }) {
  if (!result) {
    return (
      <div className="border border-dashed border-[var(--border-subtle)] rounded-lg h-10 flex items-center justify-center">
        <span className="text-[10px] text-[var(--text-muted)]">—</span>
      </div>
    );
  }

  const meta = MODEL_META[col];
  return (
    <div className="animate-snap-in flex items-center gap-2">
      <span
        className="text-[11px] font-medium px-2 py-0.5 rounded"
        style={{ background: meta.accentDim, color: meta.accent }}
      >
        {result.decision.category}
      </span>
      <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase">
        {result.decision.priority}
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-muted)]">
        {result.latencyMs}ms
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: "waiting" | "done" | "error" }) {
  if (status === "waiting") return <span className="text-xs text-[var(--text-muted)]">⏳</span>;
  if (status === "done") return <span className="text-xs text-[var(--nano-green)]">✓</span>;
  return <span className="text-xs text-red-400">✗</span>;
}
