"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  REVIEWED_LABEL_STATUSES,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_DEFINITIONS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_DEFINITIONS,
  type HumanReviewOverride,
  type HumanReviewWorksheet,
  type TicketCategory,
  type TicketPriority,
} from "../../lib/triage/schema";

interface ReviewApiResponse {
  worksheet: HumanReviewWorksheet;
  reviews: HumanReviewOverride[];
  reviewedCount: number;
  totalCount: number;
  writable: boolean;
  overridePath: string;
  error?: string;
}

interface ReviewDraft {
  category: TicketCategory | null;
  priority: TicketPriority | null;
  needsHuman: boolean | null;
  reviewStatus: (typeof REVIEWED_LABEL_STATUSES)[number];
  notes: string;
}

const EMPTY_DRAFT: ReviewDraft = {
  category: null,
  priority: null,
  needsHuman: null,
  reviewStatus: "human_reviewed",
  notes: "",
};

function draftFromReview(review: HumanReviewOverride | undefined): ReviewDraft {
  if (!review) return { ...EMPTY_DRAFT };
  return {
    category: review.category,
    priority: review.priority,
    needsHuman: review.needs_human,
    reviewStatus: review.review_status,
    notes: review.notes ?? "",
  };
}

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export default function ReviewPage() {
  const [data, setData] = useState<ReviewApiResponse | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviewer, setReviewer] = useState("");
  const [draft, setDraft] = useState<ReviewDraft>({ ...EMPTY_DRAFT });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "pending" | "saved" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedReviewer = window.localStorage.getItem(
      "ticket-triage-reviewer",
    );
    if (savedReviewer) setReviewer(savedReviewer);
    fetch("/api/review", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as ReviewApiResponse;
        if (!response.ok) throw new Error(body.error ?? "Unable to load reviews.");
        setData(body);
        const reviewedIds = new Set(body.reviews.map((review) => review.ticket_id));
        const firstUnreviewed = body.worksheet.items.findIndex(
          (item) => !reviewedIds.has(item.ticket.id),
        );
        setCurrentIndex(firstUnreviewed >= 0 ? firstUnreviewed : 0);
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, []);

  const reviewMap = useMemo(
    () => new Map(data?.reviews.map((review) => [review.ticket_id, review])),
    [data?.reviews],
  );
  const currentItem = data?.worksheet.items[currentIndex] ?? null;
  const currentReview = currentItem
    ? reviewMap.get(currentItem.ticket.id)
    : undefined;

  useEffect(() => {
    setDraft(draftFromReview(currentReview));
    setDirty(false);
    setSaveState(currentReview ? "saved" : "idle");
    setMessage(null);
  }, [currentItem?.ticket.id]);

  const priorityHumanMismatch =
    (draft.priority === "P0" || draft.priority === "P1") &&
    draft.needsHuman === false;
  const complete =
    draft.category !== null &&
    draft.priority !== null &&
    draft.needsHuman !== null &&
    reviewer.trim().length > 0 &&
    !priorityHumanMismatch;

  const updateDraft = (update: Partial<ReviewDraft>) => {
    if (!data?.writable) return;
    setDraft((previous) => ({ ...previous, ...update }));
    setDirty(true);
    setSaveState("pending");
    setMessage(null);
  };

  const saveCurrent = useCallback(
    async (advance: boolean) => {
      if (!data || !currentItem || !complete || saving || !data.writable) {
        if (!reviewer.trim()) setMessage("Enter your reviewer name before saving.");
        else if (priorityHumanMismatch)
          setMessage("P0 and P1 labels must require human review.");
        else if (!complete) setMessage("Complete all three labels before saving.");
        return false;
      }

      setSaving(true);
      setSaveState("pending");
      setMessage(null);
      window.localStorage.setItem(
        "ticket-triage-reviewer",
        reviewer.trim(),
      );
      try {
        const response = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            review: {
              ticket_id: currentItem.ticket.id,
              category: draft.category,
              priority: draft.priority,
              needs_human: draft.needsHuman,
              review_status: draft.reviewStatus,
              reviewer: reviewer.trim(),
              ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
            },
          }),
        });
        const body = (await response.json()) as ReviewApiResponse;
        if (!response.ok) throw new Error(body.error ?? "Unable to save review.");
        setData(body);
        setDirty(false);
        setSaveState("saved");
        setMessage(`Saved ${currentItem.ticket.id} to the override file.`);
        if (advance && currentIndex < body.totalCount - 1) {
          setCurrentIndex((index) => index + 1);
        }
        return true;
      } catch (error) {
        setSaveState("error");
        setMessage(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setSaving(false);
      }
    }, [
      complete,
      currentIndex,
      currentItem,
      data,
      draft,
      priorityHumanMismatch,
      reviewer,
      saving,
    ],
  );

  useEffect(() => {
    if (!dirty || !complete || saving || !data?.writable) return;
    const timer = window.setTimeout(() => {
      void saveCurrent(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [complete, data?.writable, dirty, draft, reviewer, saveCurrent, saving]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextInput(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void saveCurrent(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveCurrent]);

  const moveTo = (index: number) => {
    if (dirty || saving || !data) return;
    setCurrentIndex(Math.max(0, Math.min(index, data.totalCount - 1)));
  };

  const skipCurrent = () => {
    if (!data) return;
    setDirty(false);
    setSaveState(currentReview ? "saved" : "idle");
    setDraft(draftFromReview(currentReview));
    setMessage("Unsaved changes discarded; this ticket remains available for later review.");
    if (currentIndex < data.totalCount - 1) {
      setCurrentIndex((index) => index + 1);
    }
  };

  const moveToNextUnreviewed = () => {
    if (!data || dirty || saving) return;
    const next = data.worksheet.items.findIndex(
      (item, index) =>
        index > currentIndex && !reviewMap.has(item.ticket.id),
    );
    const wrapped = data.worksheet.items.findIndex(
      (item) => !reviewMap.has(item.ticket.id),
    );
    moveTo(next >= 0 ? next : wrapped >= 0 ? wrapped : currentIndex);
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl p-6 md:p-10">
        <p className="text-sm text-[var(--text-muted)]">Loading blind review workspace…</p>
      </main>
    );
  }

  if (!data || !currentItem) {
    return (
      <main className="mx-auto max-w-5xl p-6 md:p-10">
        <div className="rounded-xl border border-[var(--sonnet-amber-dim)] bg-[var(--bg-surface)] p-6">
          <h1 className="text-xl font-semibold">Review workspace unavailable</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">{message}</p>
        </div>
      </main>
    );
  }

  const progress = Math.round((data.reviewedCount / data.totalCount) * 100);
  const currentReviewed = reviewMap.has(currentItem.ticket.id);

  return (
    <main className="mx-auto max-w-[1500px] p-6 md:p-10">
      <header className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-[var(--routed-teal)]" />
          <span className="text-xs font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Local blind-labeling workflow
          </span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Locked Test Review
        </h1>
        <p className="mt-2 max-w-3xl text-[var(--text-secondary)]">
          Independently label all 150 tickets. This screen intentionally does not load or reveal generated source-intent labels.
        </p>
      </header>

      {!data.writable && (
        <div className="mb-6 rounded-xl border border-[var(--sonnet-amber-dim)] bg-[var(--bg-surface)] p-4 text-sm text-[var(--sonnet-amber)]">
          This completed label set is read-only. To begin an intentional relabeling session, run locally with <code className="font-[family-name:var(--font-mono)]">ALLOW_REVIEW_RELABEL=true npm run dev</code>; changing labels invalidates published result hashes.
        </div>
      )}

      <section className="mb-6 grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.1em]">What you need to do</h2>
          <ol className="mt-3 grid gap-2 text-sm text-[var(--text-secondary)] md:grid-cols-2">
            <li><strong className="text-[var(--text-primary)]">1.</strong> Enter your name or alias.</li>
            <li><strong className="text-[var(--text-primary)]">2.</strong> Read only the ticket shown here.</li>
            <li><strong className="text-[var(--text-primary)]">3.</strong> Choose category, priority, and human-review need.</li>
            <li><strong className="text-[var(--text-primary)]">4.</strong> Wait for “Saved” or use Save &amp; next.</li>
            <li><strong className="text-[var(--text-primary)]">5.</strong> Skip uncertain tickets and return later.</li>
            <li><strong className="text-[var(--text-primary)]">6.</strong> Finish when progress reaches 150/150.</li>
          </ol>
          <p className="mt-4 text-xs text-[var(--text-muted)]">
            Do not open the source-intent JSON during this first pass. Your completed labels are written only to <span className="font-[family-name:var(--font-mono)]">{data.overridePath}</span>.
          </p>
        </div>

        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">Progress</p>
              <p className="mt-1 text-2xl font-semibold">{data.reviewedCount}/{data.totalCount}</p>
            </div>
            <span className="text-sm text-[var(--routed-teal)]">{progress}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--bg-deep)]">
            <div className="h-full rounded-full bg-[var(--routed-teal)] transition-all" style={{ width: `${progress}%` }} />
          </div>
          <button
            type="button"
            onClick={moveToNextUnreviewed}
            disabled={dirty || saving || data.reviewedCount === data.totalCount}
            className="mt-4 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-medium transition-colors hover:border-[var(--routed-teal)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Go to next unreviewed
          </button>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-5">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--text-muted)]">{currentItem.ticket.id}</span>
                <span className={`rounded px-2 py-1 text-[10px] font-semibold uppercase ${currentReviewed ? "bg-[var(--routed-teal-dim)] text-[var(--routed-teal)]" : "bg-[var(--bg-elevated)] text-[var(--text-muted)]"}`}>
                  {currentReviewed ? "Reviewed" : "Unreviewed"}
                </span>
                {currentItem.ticket.customer_tier && (
                  <span className="rounded bg-[var(--bg-deep)] px-2 py-1 text-[10px] uppercase text-[var(--text-muted)]">
                    {currentItem.ticket.customer_tier} tier · context only
                  </span>
                )}
              </div>
              <span className="text-xs text-[var(--text-muted)]">Ticket {currentIndex + 1} of {data.totalCount}</span>
            </div>
            <h2 className="mt-6 text-2xl font-semibold">{currentItem.ticket.subject}</h2>
            <p className="mt-4 whitespace-pre-wrap text-base leading-7 text-[var(--text-secondary)]">{currentItem.ticket.body}</p>
          </div>

          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">
            <label className="block text-xs font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]" htmlFor="reviewer">
              Reviewer name or alias
            </label>
            <input
              id="reviewer"
              value={reviewer}
              disabled={!data.writable}
              onChange={(event) => {
                setReviewer(event.target.value);
                setDirty(true);
                setSaveState("pending");
              }}
              placeholder="Required for attribution"
              className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] px-3 py-2.5 text-sm outline-none focus:border-[var(--routed-teal)] focus:ring-1 focus:ring-[var(--routed-teal)]"
            />
          </div>

          <ReviewSection title="1. Category" hint="Choose the first matching category in the precedence order shown.">
            <div className="grid gap-2 md:grid-cols-2">
              {TICKET_CATEGORIES.map((category, index) => (
                <ChoiceButton
                  key={category}
                  selected={draft.category === category}
                  label={`${index + 1}. ${category}`}
                  description={TICKET_CATEGORY_DEFINITIONS[category]}
                  disabled={!data.writable}
                  onClick={() => updateDraft({ category })}
                />
              ))}
            </div>
          </ReviewSection>

          <ReviewSection title="2. Priority" hint="Judge impact and urgency, not customer tier.">
            <div className="grid gap-2 md:grid-cols-2">
              {TICKET_PRIORITIES.map((priority) => (
                <ChoiceButton
                  key={priority}
                  selected={draft.priority === priority}
                  label={priority}
                  description={TICKET_PRIORITY_DEFINITIONS[priority]}
                  disabled={!data.writable}
                  onClick={() =>
                    updateDraft({
                      priority,
                      ...(priority === "P0" || priority === "P1"
                        ? { needsHuman: true }
                        : {}),
                    })
                  }
                />
              ))}
            </div>
          </ReviewSection>

          <ReviewSection title="3. Needs human review?" hint="P0/P1 always means Yes. For P2/P3, follow the rubric at right.">
            <div className="grid grid-cols-2 gap-3">
              <ChoiceButton
                selected={draft.needsHuman === true}
                label="Yes"
                description="Human judgment or consequential action is required."
                disabled={!data.writable}
                onClick={() => updateDraft({ needsHuman: true })}
              />
              <ChoiceButton
                selected={draft.needsHuman === false}
                label="No"
                description="Routine, safe, and answerable without consequential action."
                disabled={!data.writable}
                onClick={() => updateDraft({ needsHuman: false })}
              />
            </div>
            {priorityHumanMismatch && (
              <p className="mt-3 text-sm text-[var(--sonnet-amber)]">P0/P1 must be marked Yes under the review rubric.</p>
            )}
          </ReviewSection>

          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div>
                <label htmlFor="review-status" className="block text-xs font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">Review status</label>
                <select
                  id="review-status"
                  value={draft.reviewStatus}
                  disabled={!data.writable}
                  onChange={(event) => updateDraft({ reviewStatus: event.target.value as ReviewDraft["reviewStatus"] })}
                  className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] px-3 py-2.5 text-sm outline-none focus:border-[var(--routed-teal)]"
                >
                  <option value="human_reviewed">Human reviewed</option>
                  <option value="adjudicated">Adjudicated</option>
                </select>
                <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">Use adjudicated only after resolving reviewer disagreement.</p>
              </div>
              <div>
                <label htmlFor="review-notes" className="block text-xs font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">Optional notes</label>
                <textarea
                  id="review-notes"
                  value={draft.notes}
                  disabled={!data.writable}
                  onChange={(event) => updateDraft({ notes: event.target.value })}
                  rows={4}
                  placeholder="Record ambiguity or adjudication rationale. Do not copy model output here."
                  className="mt-2 w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] px-3 py-2.5 text-sm outline-none focus:border-[var(--routed-teal)] focus:ring-1 focus:ring-[var(--routed-teal)]"
                />
              </div>
            </div>
          </div>

          <div className="sticky bottom-4 z-20 rounded-xl border border-[var(--border-subtle)] bg-[color:var(--bg-elevated)] p-4 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className={`text-sm font-medium ${saveState === "error" ? "text-[var(--sonnet-amber)]" : saveState === "saved" ? "text-[var(--routed-teal)]" : "text-[var(--text-secondary)]"}`}>
                  {saving ? "Saving…" : saveState === "saved" ? "Saved to JSON" : saveState === "pending" ? complete ? "Autosaves after a short pause" : "Complete the required labels" : "Not yet reviewed"}
                </p>
                {message && <p className="mt-1 max-w-2xl text-xs text-[var(--text-muted)]">{message}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => moveTo(currentIndex - 1)} disabled={currentIndex === 0 || dirty || saving} className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
                <button type="button" onClick={skipCurrent} disabled={saving} className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Skip for now</button>
                <button type="button" onClick={() => void saveCurrent(true)} disabled={!complete || saving || !data.writable} className="rounded-lg bg-[var(--routed-teal)] px-5 py-2 text-sm font-semibold text-[oklch(15%_0.01_195)] disabled:cursor-not-allowed disabled:opacity-40">
                  Save &amp; next
                </button>
                <button type="button" onClick={() => moveTo(currentIndex + 1)} disabled={currentIndex === data.totalCount - 1 || dirty || saving} className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Next</button>
              </div>
            </div>
            <p className="mt-2 text-[10px] text-[var(--text-muted)]">Shortcut: ⌘/Ctrl + Enter saves and moves next.</p>
          </div>
        </section>

        <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em]">Human-review rubric</h2>
            <div className="mt-3 whitespace-pre-line text-xs leading-5 text-[var(--text-secondary)]">{data.worksheet.needs_human_rubric}</div>
          </div>
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em]">Blind-review rules</h2>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-[var(--text-secondary)]">
              <li>• Do not inspect source-intent labels or model predictions.</li>
              <li>• Customer tier is context only and cannot determine a label.</li>
              <li>• Use notes when a case needs later adjudication.</li>
              <li>• {data.writable ? "You may revise a saved ticket; the latest review replaces it." : "The completed review set is read-only unless relabeling is explicitly enabled."}</li>
              <li>• The locked evaluation remains blocked until all 150 are complete.</li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}

function ReviewSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">
      <h2 className="text-sm font-semibold uppercase tracking-[0.1em]">{title}</h2>
      <p className="mb-4 mt-1 text-xs text-[var(--text-muted)]">{hint}</p>
      {children}
    </section>
  );
}

function ChoiceButton({
  selected,
  label,
  description,
  disabled,
  onClick,
}: {
  selected: boolean;
  label: string;
  description: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? "border-[var(--routed-teal)] bg-[var(--routed-teal-dim)]"
          : "border-[var(--border-subtle)] bg-[var(--bg-deep)] hover:border-[var(--text-muted)]"
      }`}
    >
      <span className={`block text-sm font-semibold ${selected ? "text-[var(--routed-teal)]" : "text-[var(--text-primary)]"}`}>{label}</span>
      <span className="mt-1 block text-[11px] leading-4 text-[var(--text-muted)]">{description}</span>
    </button>
  );
}
