"use client";

import { Check, Eraser, Send, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeAssistantAction, type AssistantAction } from "@/lib/assistant/types";
import { useFactoryStore } from "@/store/factory-store";
import { applyAssistantActions } from "./apply-actions";
import { useAssistantStore, type AssistantTurn } from "./assistant-store";

/**
 * The assistant: one button in the corner of the shell and the side panel it
 * opens. The panel asks Gemini through `/api/assistant`, which is where the
 * key lives, and shows whatever came back. Board changes arrive as proposals
 * with an Apply button; nothing the model says moves a card by itself.
 */
export function AssistantDock() {
  const open = useAssistantStore((state) => state.open);
  const toggle = useAssistantStore((state) => state.toggle);
  const setOpen = useAssistantStore((state) => state.setOpen);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  return (
    <>
      {/* The panel covers this corner, so the button is gone while it is open:
          a button underneath its own panel cannot be pressed. The panel's own
          X and Escape are the way back.
          The board's toolbar owns the bottom right of the canvas, which on a
          phone is the whole width, so the button steps up out of its way. */}
      {open ? null : (
        <button
          type="button"
          onClick={toggle}
          aria-label="Ask the assistant"
          aria-expanded={false}
          className="absolute bottom-3 right-3 z-[70] flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-xs text-fg shadow-[0_8px_20px_rgba(0,0,0,0.45)] transition-colors hover:bg-surface-raised compact:bottom-20"
        >
          <Sparkles aria-hidden className="h-4 w-4 text-cyan-300" />
          <span>Assistant</span>
        </button>
      )}
      {open ? <AssistantPanel /> : null}
    </>
  );
}

function AssistantPanel() {
  const turns = useAssistantStore((state) => state.turns);
  const isAsking = useAssistantStore((state) => state.isAsking);
  const error = useAssistantStore((state) => state.error);
  const ask = useAssistantStore((state) => state.ask);
  const clear = useAssistantStore((state) => state.clear);
  const setOpen = useAssistantStore((state) => state.setOpen);
  const hasDataset = useFactoryStore((state) => state.dataset !== undefined);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // A new answer is only useful if it is on screen; the panel is short.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, isAsking]);

  const send = useCallback(() => {
    const question = draft.trim();
    if (question.length === 0 || isAsking) {
      return;
    }
    setDraft("");
    void ask(question);
  }, [ask, draft, isAsking]);

  return (
    <aside
      aria-label="Assistant"
      className="absolute bottom-0 right-0 top-0 z-[75] flex w-[360px] max-w-[calc(100*var(--ui-vw)-16px)] flex-col border-l border-line bg-surface shadow-[-12px_0_28px_rgba(0,0,0,0.45)]"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-cyan-300" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Assistant</h2>
        <button
          type="button"
          onClick={clear}
          aria-label="Clear the conversation"
          className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <Eraser aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Hide the assistant"
          className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-xs">
        {turns.length === 0 ? (
          <p className="text-fg-muted">
            Ask about the cards on your board, or ask for a step to be added. It reads your open
            plan and searches the loaded recipe dataset. Changes to the board are shown to you
            first, and you apply them.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {turns.map((turn) => (
              <TurnBlock key={turn.id} turn={turn} />
            ))}
          </div>
        )}
        {isAsking ? <p className="mt-3 text-fg-muted">Thinking...</p> : null}
        {error ? <p className="mt-3 text-red-300">{error}</p> : null}
      </div>

      <div className="shrink-0 border-t border-line p-2">
        {hasDataset ? null : (
          <p className="mb-2 text-[11px] text-fg-muted">The recipe dataset is still loading.</p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Ask about this board"
            aria-label="Your question"
            className="min-w-0 flex-1 resize-none rounded border border-line bg-surface-sunken px-2 py-1.5 text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
          />
          <button
            type="button"
            onClick={send}
            disabled={isAsking || draft.trim().length === 0 || !hasDataset}
            aria-label="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line-strong bg-surface-raised text-fg disabled:opacity-40"
          >
            <Send aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-fg-subtle">Enter sends, Shift+Enter breaks a line.</p>
      </div>
    </aside>
  );
}

function TurnBlock({ turn }: { turn: AssistantTurn }) {
  if (turn.role === "user") {
    return (
      <p className="self-end rounded border border-line bg-surface-raised px-2 py-1.5 whitespace-pre-wrap">
        {turn.text}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-wrap text-fg">{turn.text}</p>
      {turn.actions ? <ProposalCard turnId={turn.id} actions={turn.actions} /> : null}
      {turn.applied ? (
        <p className="flex items-start gap-1.5 text-[11px] text-emerald-300">
          <Check aria-hidden className="mt-px h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap">{turn.applied}</span>
        </p>
      ) : null}
      {turn.lookups ? (
        <details className="text-[11px] text-fg-subtle">
          <summary className="cursor-pointer">What it looked up</summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3">
            {turn.lookups.map((lookup, index) => (
              <li key={`${lookup}-${index}`}>{lookup}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The proposed board changes, one line each, with the single Apply that runs
 * them in order. Each lands as its own store action, so undo walks back
 * through them one at a time.
 */
function ProposalCard({ turnId, actions }: { turnId: number; actions: AssistantAction[] }) {
  const markApplied = useAssistantStore((state) => state.markApplied);
  const readOnly = useFactoryStore((state) => state.isReadOnly);
  const [isApplying, setIsApplying] = useState(false);

  const apply = async () => {
    setIsApplying(true);
    try {
      const { done, skipped } = await applyAssistantActions(actions);
      markApplied(
        turnId,
        [
          done.length > 0 ? `Applied: ${done.join("; ")}.` : "Nothing was applied.",
          skipped.length > 0 ? `Skipped: ${skipped.join("; ")}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="rounded border border-cyan-800/70 bg-cyan-950/30 p-2">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
        Proposed changes
      </p>
      <ul className="flex flex-col gap-1">
        {actions.map((action, index) => (
          <li key={index} className="flex flex-col">
            <span>{describeAssistantAction(action)}</span>
            {action.reason ? <span className="text-fg-subtle">{action.reason}</span> : null}
          </li>
        ))}
      </ul>
      {readOnly ? (
        <p className="mt-2 text-[11px] text-fg-muted">
          This plan is open for viewing only. Make a copy to change it.
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void apply()}
            disabled={isApplying}
            className="rounded border border-cyan-700 bg-cyan-900/60 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-900 disabled:opacity-50"
          >
            {isApplying ? "Applying..." : "Apply to the board"}
          </button>
          <button
            type="button"
            onClick={() => markApplied(turnId, "Dismissed.")}
            className="rounded border border-line px-2 py-1 text-[11px] text-fg-muted hover:bg-surface-raised"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
