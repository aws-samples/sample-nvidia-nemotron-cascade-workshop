"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const WORKSHOP_MAX_COST_PER_TICKET_USD = 0.012;

interface Ticket {
  id: string;
  subject: string;
  body: string;
  customer_tier?: "free" | "pro" | "enterprise";
}

interface RoutingDecision {
  ticket_id: string;
  category: string;
  priority: string;
  confidence: number;
  reasoning: string;
  needs_human: boolean;
}

interface BulkResultBase {
  ticket_id: string;
  decision: RoutingDecision;
  latencyMs: number;
  cost: number;
}

interface NanoBulkResult extends BulkResultBase {
  model: "nano";
  escalated: boolean;
}

interface ClaudeBulkResult extends BulkResultBase {
  model: "claude";
}

type BulkResult = NanoBulkResult | ClaudeBulkResult;
type RowStatus = "waiting" | "escalating" | "done" | "error";

interface RowState {
  ticket: Ticket;
  nano: NanoBulkResult | null;
  claude: ClaudeBulkResult | null;
  status: RowStatus;
}

const DISPLAY_META = {
  nano: {
    label: "Nano First Pass",
    accent: "var(--nano-green)",
    accentDim: "var(--nano-green-dim)",
  },
  final: {
    label: "Final Decision",
    accent: "var(--sonnet-amber)",
    accentDim: "var(--sonnet-amber-dim)",
  },
  routing: {
    label: "Routing",
    accent: "var(--routed-teal)",
    accentDim: "var(--routed-teal-dim)",
  },
} as const;

const createRows = (tickets: Ticket[]): RowState[] =>
  tickets.map((ticket) => ({
    ticket,
    nano: null,
    claude: null,
    status: "waiting",
  }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBulkResult(value: unknown): value is BulkResult {
  if (!isRecord(value) || !isRecord(value.decision)) return false;

  const decision = value.decision;
  const sharedFieldsAreValid =
    typeof value.ticket_id === "string" &&
    (value.model === "nano" || value.model === "claude") &&
    typeof value.latencyMs === "number" &&
    typeof value.cost === "number" &&
    decision.ticket_id === value.ticket_id &&
    typeof decision.category === "string" &&
    typeof decision.priority === "string" &&
    typeof decision.confidence === "number" &&
    typeof decision.reasoning === "string" &&
    typeof decision.needs_human === "boolean";

  if (!sharedFieldsAreValid) return false;
  return value.model === "claude" || typeof value.escalated === "boolean";
}

function getEscalationReasons(result: NanoBulkResult): string[] {
  const reasons: string[] = [];

  if (result.decision.confidence < 0.7) {
    reasons.push(`Low confidence (${result.decision.confidence.toFixed(2)} < 0.70)`);
  }
  if (result.decision.priority === "P0" || result.decision.priority === "P1") {
    reasons.push(`High priority (${result.decision.priority})`);
  }
  if (result.decision.needs_human) {
    reasons.push("Human review requested");
  }

  return reasons;
}

function hasValidEscalationFlag(result: NanoBulkResult): boolean {
  return result.escalated === (getEscalationReasons(result).length > 0);
}

export default function BulkPage() {
  const [availableTickets, setAvailableTickets] = useState<Ticket[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [rows, setRows] = useState<RowState[]>([]);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [costAcknowledged, setCostAcknowledged] = useState(false);
  const [endpointError, setEndpointError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tickets")
      .then((response) => response.json())
      .then((data: Ticket[]) => setAvailableTickets(data.slice(0, 30)));
  }, []);

  const summary = useMemo(() => {
    const nanoResults = rows.flatMap((row) => (row.nano ? [row.nano] : []));
    const claudeResults = rows.flatMap((row) => (row.claude ? [row.claude] : []));
    const escalatedCount = nanoResults.filter((result) => result.escalated).length;
    const completedRows = rows.filter((row) => row.status === "done");
    const nanoLatency = nanoResults.reduce((total, result) => total + result.latencyMs, 0);
    const claudeLatency = claudeResults.reduce((total, result) => total + result.latencyMs, 0);

    return {
      nanoCount: nanoResults.length,
      nanoCost: nanoResults.reduce((total, result) => total + result.cost, 0),
      nanoAvgLatency: nanoResults.length ? Math.round(nanoLatency / nanoResults.length) : 0,
      claudeCount: claudeResults.length,
      claudeCost: claudeResults.reduce((total, result) => total + result.cost, 0),
      claudeAvgLatency: claudeResults.length ? Math.round(claudeLatency / claudeResults.length) : 0,
      escalatedCount,
      escalationRate: nanoResults.length ? Math.round((escalatedCount / nanoResults.length) * 100) : 0,
      completedCount: completedRows.length,
      totalCost:
        nanoResults.reduce((total, result) => total + result.cost, 0) +
        claudeResults.reduce((total, result) => total + result.cost, 0),
      avgModelTime: completedRows.length
        ? Math.round(
            completedRows.reduce(
              (total, row) => total + (row.nano?.latencyMs ?? 0) + (row.claude?.latencyMs ?? 0),
              0,
            ) / completedRows.length,
          )
        : 0,
    };
  }, [rows]);

  const loadTickets = () => {
    setTickets(availableTickets);
    setRows(createRows(availableTickets));
    setLoaded(true);
    setCostAcknowledged(false);
    setEndpointError(null);
  };

  const runBulk = useCallback(async () => {
    if (!tickets.length) return;

    setRunning(true);
    setEndpointError(null);
    setRows(createRows(tickets));

    const applyResult = (result: BulkResult) => {
      setRows((previousRows) =>
        previousRows.map((row) => {
          if (row.ticket.id !== result.ticket_id) return row;

          if (result.model === "nano") {
            if (!hasValidEscalationFlag(result)) {
              return { ...row, nano: result, status: "error" };
            }
            return {
              ...row,
              nano: result,
              status: result.escalated
                ? row.claude
                  ? "done"
                  : "escalating"
                : row.claude
                  ? "error"
                  : "done",
            };
          }

          return {
            ...row,
            claude: result,
            status: row.nano?.escalated ? "done" : "error",
          };
        }),
      );
    };

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isBulkResult(parsed)) applyResult(parsed);
      } catch {
        // A malformed record is ignored; any unresolved row is marked failed when the stream closes.
      }
    };

    try {
      const response = await fetch("/api/triage/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickets }),
      });

      if (!response.ok) {
        setEndpointError(
          response.status === 404
            ? "/api/triage/bulk not found"
            : `Bulk triage request failed (${response.status})`,
        );
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setEndpointError("Bulk triage response did not include a readable stream");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(consumeLine);
      }

      buffer += decoder.decode();
      consumeLine(buffer);
    } catch {
      setEndpointError("Unable to read the bulk triage stream");
    } finally {
      setRunning(false);
      setRows((previousRows) =>
        previousRows.map((row) =>
          row.status === "waiting" || row.status === "escalating"
            ? { ...row, status: "error" }
            : row,
        ),
      );
    }
  }, [tickets]);

  const hasResults = summary.nanoCount > 0 || summary.claudeCount > 0;

  return (
    <div className="min-h-screen p-6 md:p-10 max-w-[1600px] mx-auto">
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
        <p className="mt-2 text-[var(--text-secondary)] text-base max-w-3xl">
          Stream Nano first-pass decisions and watch low-confidence or high-stakes tickets route to
          Sonnet for the final decision.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          onClick={loadTickets}
          disabled={running || availableTickets.length === 0}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all
            border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]
            hover:bg-[var(--bg-elevated)] active:scale-[0.98]
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {availableTickets.length > 0
            ? `Load ${availableTickets.length} sample tickets`
            : "Loading sample tickets..."}
        </button>
        <button
          onClick={runBulk}
          disabled={!loaded || running || !costAcknowledged}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all
            bg-[var(--nano-green)] text-[oklch(15%_0.01_145)]
            hover:brightness-110 active:scale-[0.98]
            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
        >
          {running ? "Running..." : "Run Bulk Triage"}
        </button>
        {loaded && <span className="text-xs text-[var(--text-muted)]">{tickets.length} tickets loaded</span>}
      </div>

      {loaded && (
        <label className="mb-6 flex max-w-3xl items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 text-sm text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={costAcknowledged}
            onChange={(event) => setCostAcknowledged(event.target.checked)}
            disabled={running}
            className="mt-0.5 h-4 w-4 accent-[var(--nano-green)]"
          />
          <span>
            I understand this run invokes paid Amazon Bedrock APIs. For {tickets.length} tickets,
            it makes {tickets.length} Nano calls and up to {tickets.length} additional Sonnet calls,
            depending on escalation. Based on the sample pricing snapshot, budget up to about ${
              (tickets.length * WORKSHOP_MAX_COST_PER_TICKET_USD).toFixed(2)
            } and 1–5 minutes; actual pricing, tokens, quotas, and latency vary.
          </span>
        </label>
      )}

      {endpointError && (
        <div className="animate-snap-in rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 mb-6 text-center">
          <div className="text-4xl mb-3">🚧</div>
          <p className="text-lg font-semibold text-[var(--text-primary)] mb-2">{endpointError}</p>
          <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
            The endpoint must accept <code className="px-1 py-0.5 rounded bg-[var(--bg-deep)] font-[family-name:var(--font-mono)] text-xs">POST {"{"} tickets: Ticket[] {"}"}</code> and return one Nano or Claude event per NDJSON line.
          </p>
        </div>
      )}

      {loaded && !endpointError && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--bg-elevated)]">
                <tr className="border-b border-[var(--border-subtle)]">
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium w-12">#</th>
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium min-w-[200px]">Subject</th>
                  {Object.values(DISPLAY_META).map((meta) => (
                    <th key={meta.label} className="text-left px-4 py-3 min-w-[210px]">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: meta.accent }} />
                        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium">{meta.label}</span>
                      </div>
                    </th>
                  ))}
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] font-medium w-20">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => <TableRow key={row.ticket.id} row={row} index={index} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loaded && !endpointError && (
        <div className="rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)] p-12 text-center">
          <p className="text-sm text-[var(--text-muted)]">Load sample tickets to populate the table</p>
        </div>
      )}

      {loaded && hasResults && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <SummaryCard
            meta={DISPLAY_META.nano}
            values={[
              ["Estimated cost", `$${summary.nanoCost.toFixed(4)}`],
              ["Avg latency", `${summary.nanoAvgLatency.toLocaleString()}ms`],
              ["First passes", `${summary.nanoCount}/${tickets.length}`],
            ]}
          />
          <SummaryCard
            meta={DISPLAY_META.final}
            values={[
              ["Estimated cost", `$${summary.claudeCost.toFixed(4)}`],
              ["Avg latency", `${summary.claudeAvgLatency.toLocaleString()}ms`],
              ["Sonnet calls", `${summary.claudeCount}/${summary.escalatedCount}`],
            ]}
          />
          <SummaryCard
            meta={DISPLAY_META.routing}
            values={[
              ["Total estimated cost", `$${summary.totalCost.toFixed(4)}`],
              ["Escalated", `${summary.escalatedCount} (${summary.escalationRate}%)`],
              ["Resolved", `${summary.completedCount}/${tickets.length}`],
            ]}
            footer={`Avg model time ${summary.avgModelTime.toLocaleString()}ms per resolved ticket`}
          />
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
      <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-xs text-[var(--text-muted)]">{row.ticket.id.replace("T-", "")}</td>
      <td className="px-4 py-3 text-[var(--text-secondary)] truncate max-w-[250px]" title={row.ticket.subject}>{row.ticket.subject}</td>
      <td className="px-4 py-3"><DecisionCell result={row.nano} modelLabel="Nano" accent="nano" /></td>
      <td className="px-4 py-3"><FinalDecisionCell row={row} /></td>
      <td className="px-4 py-3"><RoutingCell row={row} /></td>
      <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
    </tr>
  );
}

function DecisionCell({
  result,
  modelLabel,
  accent,
}: {
  result: BulkResult | null;
  modelLabel: string;
  accent: "nano" | "final";
}) {
  if (!result) return <EmptyCell />;

  const meta = DISPLAY_META[accent];
  return (
    <div className="animate-snap-in">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium px-2 py-0.5 rounded" style={{ background: meta.accentDim, color: meta.accent }}>{result.decision.category}</span>
        <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase">{result.decision.priority}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-muted)]">
        <span>{modelLabel}</span>
        <span>{Math.round(result.decision.confidence * 100)}%</span>
        <span>{result.latencyMs}ms</span>
      </div>
    </div>
  );
}

function FinalDecisionCell({ row }: { row: RowState }) {
  if (!row.nano) {
    if (row.claude) return <ContractMismatch message="Sonnet arrived before Nano" />;
    return <EmptyCell />;
  }

  if (!hasValidEscalationFlag(row.nano)) {
    return <ContractMismatch message="Nano escalation flag violates the core routing policy" />;
  }

  if (!row.nano.escalated) {
    if (row.claude) return <ContractMismatch message="Unexpected Sonnet event" />;
    return <DecisionCell result={row.nano} modelLabel="Nano final" accent="nano" />;
  }

  if (!row.claude) {
    return (
      <div className="border border-dashed border-[var(--sonnet-amber-dim)] rounded-lg min-h-10 px-3 py-2 flex items-center">
        <span className="text-[10px] text-[var(--sonnet-amber)]">Awaiting Sonnet final decision…</span>
      </div>
    );
  }

  return <DecisionCell result={row.claude} modelLabel="Sonnet final" accent="final" />;
}

function RoutingCell({ row }: { row: RowState }) {
  if (!row.nano) return <EmptyCell />;

  const reasons = getEscalationReasons(row.nano);
  if (!hasValidEscalationFlag(row.nano)) {
    return <ContractMismatch message="Escalation flag does not match the core routing policy" />;
  }
  if (!row.nano.escalated) {
    return (
      <span className="inline-flex text-[11px] font-medium px-2 py-1 rounded bg-[var(--nano-green-dim)] text-[var(--nano-green)]">
        Nano only
      </span>
    );
  }

  return (
    <div className="animate-snap-in">
      <span className="inline-flex text-[11px] font-medium px-2 py-1 rounded bg-[var(--routed-teal-dim)] text-[var(--routed-teal)]">
        Nano → Sonnet
      </span>
      <div className="mt-1 text-[10px] leading-4 text-[var(--text-muted)]">
        {reasons.length > 0 ? reasons.join(" · ") : "Escalated; no matching core reason in event"}
      </div>
    </div>
  );
}

function EmptyCell() {
  return (
    <div className="border border-dashed border-[var(--border-subtle)] rounded-lg h-10 flex items-center justify-center">
      <span className="text-[10px] text-[var(--text-muted)]">—</span>
    </div>
  );
}

function ContractMismatch({ message }: { message: string }) {
  return <span className="text-[10px] text-red-400">{message}</span>;
}

function StatusBadge({ status }: { status: RowStatus }) {
  if (status === "waiting") return <span className="text-xs text-[var(--text-muted)]">⏳</span>;
  if (status === "escalating") return <span className="text-xs text-[var(--sonnet-amber)]" title="Waiting for Sonnet">↗</span>;
  if (status === "done") return <span className="text-xs text-[var(--nano-green)]">✓</span>;
  return <span className="text-xs text-red-400" title="Stream ended before a valid final result">✗</span>;
}

function SummaryCard({
  meta,
  values,
  footer,
}: {
  meta: { label: string; accent: string };
  values: [string, string][];
  footer?: string;
}) {
  return (
    <div className="animate-snap-in rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2 h-2 rounded-full" style={{ background: meta.accent }} />
        <span className="text-xs font-semibold text-[var(--text-primary)]">{meta.label}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {values.map(([label, value]) => (
          <div key={label}>
            <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block">{label}</span>
            <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[var(--text-primary)]">{value}</span>
          </div>
        ))}
      </div>
      {footer && <p className="mt-3 text-[10px] text-[var(--text-muted)]">{footer}</p>}
    </div>
  );
}
