"use client";

import { useState, useRef, useCallback } from "react";

interface RoutingDecision {
  ticket_id: string;
  category: string;
  priority: string;
  confidence: number;
  reasoning: string;
  needs_human: boolean;
}

interface NanoResult {
  decision: RoutingDecision;
  escalating: boolean;
  latencyMs: number;
  cost: number;
}

interface ClaudeResult {
  decision: RoutingDecision;
  latencyMs: number;
  cost: number;
}

interface DoneResult {
  finalDecision: RoutingDecision;
  modelUsed: string;
  escalated: boolean;
  totalLatencyMs: number;
  totalCost: number;
}

interface SessionStats {
  total: number;
  nanoResolved: number;
  escalated: number;
  totalCost: number;
  totalLatency: number;
}

type Stage =
  | "idle"
  | "nano-running"
  | "nano-done"
  | "escalating"
  | "claude-running"
  | "claude-done"
  | "done";

const SAMPLE_TICKETS = [
  {
    label: "Billing dispute (confident Nano)",
    subject: "Charged twice for November",
    body: "I was charged $49.99 twice on Nov 3rd and Nov 4th for my Pro plan. I only have one account. Please refund the duplicate charge. My card ending 4242.",
    customer_tier: "pro" as const,
  },
  {
    label: "Critical data issue (escalates)",
    subject: "URGENT: customer data missing from dashboard",
    body: "Our entire customer list disappeared from the analytics dashboard overnight. We have a board meeting in 2 hours and need this data. Enterprise account, 50k+ records. Nothing shows when I filter by any date range. This is a P0 for us.",
    customer_tier: "enterprise" as const,
  },
  {
    label: "Simple feature question (confident Nano)",
    subject: "How do I export to CSV?",
    body: "Is there a way to export my ticket history to CSV? I need to import into our internal tracking system. Looked in settings but couldn't find it.",
    customer_tier: "free" as const,
  },
  {
    label: "Auth loop (likely escalates)",
    subject: "SAML login redirect loop after SSO config",
    body: "After configuring SAML SSO with Okta, users get stuck in a redirect loop. Browser shows ERR_TOO_MANY_REDIRECTS. ACS URL and Entity ID are correct per Okta docs. Affects all 200+ users on our enterprise plan. Need immediate help.",
    customer_tier: "enterprise" as const,
  },
];

export default function CascadeDemo() {
  const [subject, setSubject] = useState(SAMPLE_TICKETS[0].subject);
  const [body, setBody] = useState(SAMPLE_TICKETS[0].body);
  const [tier, setTier] = useState<string>(SAMPLE_TICKETS[0].customer_tier);
  const [stage, setStage] = useState<Stage>("idle");
  const [nanoResult, setNanoResult] = useState<NanoResult | null>(null);
  const [claudeResult, setClaudeResult] = useState<ClaudeResult | null>(null);
  const [doneResult, setDoneResult] = useState<DoneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    total: 0,
    nanoResolved: 0,
    escalated: 0,
    totalCost: 0,
    totalLatency: 0,
  });
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);

  const startTimer = useCallback(() => {
    startTimeRef.current = performance.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.round(performance.now() - startTimeRef.current));
    }, 50);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const selectSample = (idx: number) => {
    const sample = SAMPLE_TICKETS[idx];
    setSubject(sample.subject);
    setBody(sample.body);
    setTier(sample.customer_tier);
  };

  const handleTriage = async () => {
    setStage("nano-running");
    setNanoResult(null);
    setClaudeResult(null);
    setDoneResult(null);
    setError(null);
    setElapsed(0);
    startTimer();

    try {
      const res = await fetch("/api/triage/cascade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body, customer_tier: tier }),
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ") && eventType) {
            const data = JSON.parse(line.slice(6));
            switch (eventType) {
              case "nano-result": {
                const nr = data as NanoResult;
                setNanoResult(nr);
                if (nr.escalating) {
                  setStage("escalating");
                } else {
                  setStage("nano-done");
                }
                break;
              }
              case "claude-start":
                setStage("claude-running");
                break;
              case "claude-result":
                setClaudeResult(data as ClaudeResult);
                setStage("claude-done");
                break;
              case "done": {
                const dr = data as DoneResult;
                setDoneResult(dr);
                setStage("done");
                stopTimer();
                setSessionStats((prev) => ({
                  total: prev.total + 1,
                  nanoResolved: prev.nanoResolved + (dr.escalated ? 0 : 1),
                  escalated: prev.escalated + (dr.escalated ? 1 : 0),
                  totalCost: prev.totalCost + dr.totalCost,
                  totalLatency: prev.totalLatency + dr.totalLatencyMs,
                }));
                break;
              }
              case "error":
                setError(data.message);
                setStage("idle");
                stopTimer();
                break;
            }
            eventType = "";
          }
        }
      }
    } catch (err) {
      console.error("Cascade triage failed:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
      setStage("idle");
      stopTimer();
    }
  };

  const isRunning = stage === "nano-running" || stage === "claude-running" || stage === "escalating";

  return (
    <div className="min-h-screen p-6 md:p-10 max-w-[1200px] mx-auto">
      {/* Header */}
      <header className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-2 rounded-full bg-[var(--nano-green)]" />
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--text-muted)] font-medium">
            Amazon Bedrock + NVIDIA Nemotron Workshop
          </span>
        </div>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Cascade Routing Demo
        </h1>
        <p className="mt-2 text-[var(--text-secondary)] text-base max-w-2xl">
          Watch the two-stage triage system work in real time. Nemotron Nano handles the easy 80% — 
          uncertain or critical tickets escalate to Claude Sonnet for verification.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-8">
        {/* Input Panel */}
        <aside className="space-y-5">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 space-y-4">
            {/* Sample ticket selector */}
            <div>
              <label className="block text-xs uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2 font-medium">
                Sample Tickets
              </label>
              <div className="grid grid-cols-1 gap-1.5">
                {SAMPLE_TICKETS.map((sample, idx) => (
                  <button
                    key={idx}
                    onClick={() => selectSample(idx)}
                    className="text-left px-3 py-2 rounded-lg text-xs text-[var(--text-secondary)] 
                      bg-[var(--bg-deep)] border border-[var(--border-subtle)]
                      hover:border-[var(--nano-green)] hover:text-[var(--text-primary)] 
                      transition-all truncate"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs uppercase tracking-[0.1em] text-[var(--text-muted)] mb-1.5 font-medium">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--nano-green)] focus:border-[var(--nano-green)] transition-all"
                placeholder="Ticket subject..."
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-[0.1em] text-[var(--text-muted)] mb-1.5 font-medium">
                Body
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                className="w-full bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--nano-green)] focus:border-[var(--nano-green)] transition-all resize-none"
                placeholder="Describe the issue..."
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-[0.1em] text-[var(--text-muted)] mb-1.5 font-medium">
                Customer Tier
              </label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                className="w-full bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--nano-green)] focus:border-[var(--nano-green)] transition-all"
              >
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
          </div>

          <button
            onClick={handleTriage}
            disabled={isRunning || !subject.trim() || !body.trim()}
            className="w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all
              bg-[var(--nano-green)] text-[oklch(15%_0.01_145)] hover:brightness-110
              disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100
              active:scale-[0.98]"
          >
            {isRunning ? "Triaging..." : "Triage Ticket"}
          </button>

          {isRunning && (
            <div className="text-center">
              <span className="font-[family-name:var(--font-mono)] text-2xl text-[var(--text-primary)] timer-pulse">
                {(elapsed / 1000).toFixed(1)}s
              </span>
            </div>
          )}

          {/* How it works */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <h3 className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)] font-medium mb-3">
              How it works
            </h3>
            <div className="font-[family-name:var(--font-mono)] text-xs text-[var(--text-secondary)] space-y-1 leading-relaxed">
              <p className="text-[var(--text-primary)]">Ticket → Nemotron Nano <span className="text-[var(--nano-green)]">(fast, cheap)</span></p>
              <p className="pl-4">├─ confident? → Done ✓</p>
              <p className="pl-4">└─ uncertain/critical? →</p>
              <p className="pl-8">Claude Sonnet <span className="text-[var(--sonnet-amber)]">(thorough)</span> → Done ✓</p>
            </div>
            <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] space-y-0.5">
              <p>Escalation triggers:</p>
              <p className="font-[family-name:var(--font-mono)]">• confidence &lt; 0.7</p>
              <p className="font-[family-name:var(--font-mono)]">• priority = P0 or P1</p>
              <p className="font-[family-name:var(--font-mono)]">• needs_human = true</p>
            </div>
          </div>
        </aside>

        {/* Results Panel */}
        <section className="space-y-4">
          {/* Nano Panel */}
          <NanoPanel stage={stage} result={nanoResult} elapsed={elapsed} />

          {/* Escalation connector */}
          {(stage === "escalating" || stage === "claude-running" || stage === "claude-done" || (stage === "done" && doneResult?.escalated)) && (
            <EscalationConnector nanoResult={nanoResult} />
          )}

          {/* Claude Panel */}
          <ClaudePanel stage={stage} result={claudeResult} nanoResult={nanoResult} doneResult={doneResult} />

          {/* Summary Banner */}
          {stage === "done" && doneResult && (
            <SummaryBanner doneResult={doneResult} nanoResult={nanoResult} claudeResult={claudeResult} />
          )}

          {/* Error */}
          {error && (
            <div className="animate-snap-in rounded-xl border border-red-500/30 bg-red-950/20 p-4">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Session Stats */}
          {sessionStats.total > 0 && (
            <div className="animate-snap-in rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
              <h3 className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)] font-medium mb-3">
                Session Stats
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <StatBox label="Triaged" value={String(sessionStats.total)} />
                <StatBox
                  label="Nano resolved"
                  value={`${sessionStats.nanoResolved} (${Math.round((sessionStats.nanoResolved / sessionStats.total) * 100)}%)`}
                />
                <StatBox
                  label="Escalated"
                  value={`${sessionStats.escalated} (${Math.round((sessionStats.escalated / sessionStats.total) * 100)}%)`}
                />
                <StatBox
                  label="Avg cost"
                  value={`$${(sessionStats.totalCost / sessionStats.total).toFixed(4)}`}
                />
                <StatBox
                  label="Avg latency"
                  value={`${Math.round(sessionStats.totalLatency / sessionStats.total).toLocaleString()}ms`}
                />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NanoPanel({ stage, result, elapsed }: { stage: Stage; result: NanoResult | null; elapsed: number }) {
  const isActive = stage === "nano-running";
  const isDone = result !== null;
  const isConfident = isDone && !result.escalating;

  return (
    <div
      className={`rounded-xl border overflow-hidden transition-all duration-300 ${
        isActive
          ? "border-[var(--nano-green)] shadow-[0_0_20px_rgba(100,200,100,0.1)]"
          : isDone && isConfident
            ? "border-[var(--nano-green)]/50"
            : isDone && result.escalating
              ? "border-[var(--sonnet-amber)]/50"
              : "border-[var(--border-subtle)]"
      } bg-[var(--bg-surface)]`}
    >
      {/* Header */}
      <div className="px-5 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-all ${
              isActive ? "bg-[var(--nano-green)] timer-pulse" : isDone ? "bg-[var(--nano-green)]" : "bg-[var(--text-muted)]/30"
            }`}
          />
          <span className="text-sm font-semibold text-[var(--text-primary)]">Nemotron Nano</span>
          <span className="text-[10px] uppercase tracking-[0.1em] px-2 py-0.5 rounded font-medium bg-[var(--nano-green-dim)] text-[var(--nano-green)]">
            NVIDIA
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <span className="text-xs text-[var(--text-muted)] font-[family-name:var(--font-mono)]">
              {(elapsed / 1000).toFixed(1)}s
            </span>
          )}
          {isDone && (
            <span className={`text-lg ${isConfident ? "" : "text-[var(--sonnet-amber)]"}`}>
              {isConfident ? "✓" : "⚠️"}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-5">
        {stage === "idle" && (
          <div className="flex items-center justify-center h-[100px]">
            <span className="text-sm text-[var(--text-muted)]">Step 1: Fast classification with Nano</span>
          </div>
        )}

        {isActive && (
          <div className="flex flex-col items-center justify-center h-[100px] gap-3">
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full timer-pulse bg-[var(--nano-green)]" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full timer-pulse bg-[var(--nano-green)]" style={{ animationDelay: "200ms" }} />
              <div className="w-2 h-2 rounded-full timer-pulse bg-[var(--nano-green)]" style={{ animationDelay: "400ms" }} />
            </div>
            <span className="text-xs text-[var(--text-muted)]">Classifying with Nemotron Nano...</span>
          </div>
        )}

        {isDone && result && (
          <div className="animate-snap-in space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <DataBadge label="Category" value={result.decision.category} />
              <DataBadge label="Priority" value={result.decision.priority} />
              <DataBadge
                label="Confidence"
                value={`${(result.decision.confidence * 100).toFixed(0)}%`}
                highlight={result.decision.confidence < 0.7 ? "warning" : "good"}
              />
              <DataBadge label="Needs Human" value={result.decision.needs_human ? "Yes" : "No"} highlight={result.decision.needs_human ? "warning" : undefined} />
            </div>

            <div>
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block mb-1">
                Reasoning
              </span>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {result.decision.reasoning}
              </p>
            </div>

            {/* Metrics */}
            <div className="flex gap-2 pt-3 border-t border-[var(--border-subtle)]">
              <MetricPill color="var(--nano-green)" bg="var(--nano-green-dim)" value={`${result.latencyMs.toLocaleString()}ms`} />
              <MetricPill color="var(--nano-green)" bg="var(--nano-green-dim)" value={`$${result.cost.toFixed(4)}`} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EscalationConnector({ nanoResult }: { nanoResult: NanoResult | null }) {
  if (!nanoResult) return null;

  const triggers: string[] = [];
  if (nanoResult.decision.confidence < 0.7) triggers.push(`confidence: ${(nanoResult.decision.confidence * 100).toFixed(0)}% < 70%`);
  if (nanoResult.decision.priority === "P0") triggers.push("priority: P0");
  if (nanoResult.decision.priority === "P1") triggers.push("priority: P1");
  if (nanoResult.decision.needs_human) triggers.push("needs_human: true");

  return (
    <div className="animate-snap-in flex items-center gap-3 px-5 py-3">
      <div className="flex-1 h-px bg-gradient-to-r from-[var(--nano-green)] via-[var(--sonnet-amber)] to-[var(--sonnet-amber)]" />
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--sonnet-amber-dim)] border border-[var(--sonnet-amber)]/30">
        <span className="text-xs font-semibold text-[var(--sonnet-amber)]">ESCALATING</span>
      </div>
      <div className="flex-1 h-px bg-[var(--sonnet-amber)]/30" />
      <div className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--text-muted)]">
        {triggers.join(" · ")}
      </div>
    </div>
  );
}

function ClaudePanel({
  stage,
  result,
  nanoResult,
  doneResult,
}: {
  stage: Stage;
  result: ClaudeResult | null;
  nanoResult: NanoResult | null;
  doneResult: DoneResult | null;
}) {
  const shouldShow = stage === "escalating" || stage === "claude-running" || stage === "claude-done" || (stage === "done" && doneResult?.escalated);
  const notNeeded = stage === "done" && !doneResult?.escalated;
  const isActive = stage === "claude-running";
  const isDone = result !== null;

  return (
    <div
      className={`rounded-xl border overflow-hidden transition-all duration-300 ${
        shouldShow
          ? isActive
            ? "border-[var(--sonnet-amber)] shadow-[0_0_20px_rgba(200,150,50,0.1)]"
            : isDone
              ? "border-[var(--sonnet-amber)]/50"
              : "border-[var(--border-subtle)]"
          : notNeeded
            ? "border-[var(--border-subtle)] opacity-60"
            : "border-[var(--border-subtle)] opacity-30"
      } bg-[var(--bg-surface)]`}
    >
      {/* Header */}
      <div className="px-5 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-all ${
              isActive ? "bg-[var(--sonnet-amber)] timer-pulse" : isDone ? "bg-[var(--sonnet-amber)]" : "bg-[var(--text-muted)]/30"
            }`}
          />
          <span className="text-sm font-semibold text-[var(--text-primary)]">Claude Sonnet 4.6</span>
          <span className="text-[10px] uppercase tracking-[0.1em] px-2 py-0.5 rounded font-medium bg-[var(--sonnet-amber-dim)] text-[var(--sonnet-amber)]">
            Anthropic
          </span>
        </div>
        {isDone && <span className="text-lg">✓</span>}
      </div>

      {/* Body */}
      <div className="p-5">
        {notNeeded && nanoResult && (
          <div className="flex items-center justify-center h-[60px]">
            <span className="text-sm text-[var(--text-muted)]">
              Not needed — Nano was confident ({(nanoResult.decision.confidence * 100).toFixed(0)}%)
            </span>
          </div>
        )}

        {!shouldShow && !notNeeded && (
          <div className="flex items-center justify-center h-[60px]">
            <span className="text-sm text-[var(--text-muted)]">Standby — activates on escalation</span>
          </div>
        )}

        {(stage === "escalating" || isActive) && !isDone && (
          <div className="flex flex-col items-center justify-center h-[100px] gap-3">
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full timer-pulse bg-[var(--sonnet-amber)]" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full timer-pulse bg-[var(--sonnet-amber)]" style={{ animationDelay: "200ms" }} />
              <div className="w-2 h-2 rounded-full timer-pulse bg-[var(--sonnet-amber)]" style={{ animationDelay: "400ms" }} />
            </div>
            <span className="text-xs text-[var(--text-muted)]">Verifying with Claude Sonnet...</span>
          </div>
        )}

        {isDone && result && (
          <div className="animate-snap-in space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <DataBadge label="Category" value={result.decision.category} />
              <DataBadge label="Priority" value={result.decision.priority} />
              <DataBadge label="Confidence" value={`${(result.decision.confidence * 100).toFixed(0)}%`} highlight="good" />
              <DataBadge label="Needs Human" value={result.decision.needs_human ? "Yes" : "No"} />
            </div>

            <div>
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block mb-1">
                Reasoning
              </span>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {result.decision.reasoning}
              </p>
            </div>

            {/* Comparison with Nano */}
            {nanoResult && (
              <div className="rounded-lg bg-[var(--bg-deep)] p-3 border border-[var(--border-subtle)]">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block mb-2">
                  Nano vs Claude comparison
                </span>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-[var(--text-muted)] block">Category</span>
                    <span className={`font-medium ${nanoResult.decision.category === result.decision.category ? "text-[var(--nano-green)]" : "text-[var(--sonnet-amber)]"}`}>
                      {nanoResult.decision.category === result.decision.category ? "✓ Agree" : `Nano: ${nanoResult.decision.category}`}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-muted)] block">Priority</span>
                    <span className={`font-medium ${nanoResult.decision.priority === result.decision.priority ? "text-[var(--nano-green)]" : "text-[var(--sonnet-amber)]"}`}>
                      {nanoResult.decision.priority === result.decision.priority ? "✓ Agree" : `Nano: ${nanoResult.decision.priority}`}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-muted)] block">Human?</span>
                    <span className={`font-medium ${nanoResult.decision.needs_human === result.decision.needs_human ? "text-[var(--nano-green)]" : "text-[var(--sonnet-amber)]"}`}>
                      {nanoResult.decision.needs_human === result.decision.needs_human ? "✓ Agree" : `Nano: ${nanoResult.decision.needs_human ? "Yes" : "No"}`}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Metrics */}
            <div className="flex gap-2 pt-3 border-t border-[var(--border-subtle)]">
              <MetricPill color="var(--sonnet-amber)" bg="var(--sonnet-amber-dim)" value={`${result.latencyMs.toLocaleString()}ms`} />
              <MetricPill color="var(--sonnet-amber)" bg="var(--sonnet-amber-dim)" value={`$${result.cost.toFixed(4)}`} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryBanner({
  doneResult,
  nanoResult,
  claudeResult,
}: {
  doneResult: DoneResult;
  nanoResult: NanoResult | null;
  claudeResult: ClaudeResult | null;
}) {
  return (
    <div className="animate-slide-up rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${doneResult.escalated ? "text-[var(--sonnet-amber)]" : "text-[var(--nano-green)]"}`}>
            {doneResult.escalated ? "🔀" : "⚡"}
          </span>
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {doneResult.escalated
              ? "Escalated: Nano → Claude Sonnet"
              : "Resolved by Nemotron Nano"}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-[family-name:var(--font-mono)] text-lg font-bold text-[var(--text-primary)]">
            {doneResult.totalLatencyMs.toLocaleString()}ms
          </span>
          <span className="text-xs text-[var(--text-muted)]">total</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-[family-name:var(--font-mono)] text-lg font-bold text-[var(--text-primary)]">
            ${doneResult.totalCost.toFixed(4)}
          </span>
          <span className="text-xs text-[var(--text-muted)]">cost</span>
        </div>
        {doneResult.escalated && nanoResult && claudeResult && (
          <div className="text-xs text-[var(--text-muted)]">
            Nano: {nanoResult.latencyMs}ms + Claude: {claudeResult.latencyMs}ms
          </div>
        )}
      </div>
    </div>
  );
}

function DataBadge({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "good" | "warning";
}) {
  return (
    <div className="bg-[var(--bg-deep)] rounded-lg px-2.5 py-2">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block">
        {label}
      </span>
      <span
        className={`text-sm font-medium font-[family-name:var(--font-mono)] ${
          highlight === "good"
            ? "text-[var(--nano-green)]"
            : highlight === "warning"
              ? "text-[var(--sonnet-amber)]"
              : "text-[var(--text-primary)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function MetricPill({ color, bg, value }: { color: string; bg: string; value: string }) {
  return (
    <span
      className="font-[family-name:var(--font-mono)] text-xs px-2.5 py-1 rounded font-medium"
      style={{ background: bg, color }}
    >
      {value}
    </span>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] block">{label}</span>
      <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
