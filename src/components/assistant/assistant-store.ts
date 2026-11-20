"use client";

import { create } from "zustand";
import { buildAssistantBoardSnapshot } from "@/lib/assistant/board-snapshot";
import type { AssistantAction, AssistantChatMessage, AssistantReply } from "@/lib/assistant/types";
import { useFactoryStore } from "@/store/factory-store";

/**
 * The assistant panel's own state: the conversation, what Gemini has proposed
 * for the board, and whether an ask is in flight. Deliberately NOT persisted.
 * A conversation about a board is worthless against a different board, and a
 * reload is the one moment a player can be sure the panel is empty.
 */

export interface AssistantTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Assistant turns only: what it wants done to the board, until applied. */
  actions?: AssistantAction[];
  /** The lookups the answer was built on, shown folded under it. */
  lookups?: string[];
  /** Set once the player has pressed Apply, so the buttons do not come back. */
  applied?: string;
}

interface AssistantStore {
  open: boolean;
  turns: AssistantTurn[];
  isAsking: boolean;
  error?: string;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  ask: (text: string) => Promise<void>;
  markApplied: (turnId: number, summary: string) => void;
  clear: () => void;
}

let nextTurnId = 1;

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  open: false,
  turns: [],
  isAsking: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
  clear: () => set({ turns: [], error: undefined }),
  markApplied: (turnId, summary) =>
    set((state) => ({
      turns: state.turns.map((turn) =>
        turn.id === turnId ? { ...turn, applied: summary, actions: undefined } : turn,
      ),
    })),
  ask: async (text) => {
    const question = text.trim();
    if (question.length === 0 || get().isAsking) {
      return;
    }

    const asked: AssistantTurn = { id: nextTurnId++, role: "user", text: question };
    set((state) => ({ turns: [...state.turns, asked], isAsking: true, error: undefined }));

    const factory = useFactoryStore.getState();
    const datasetVersionId = factory.dataset?.datasetVersionId;
    if (!datasetVersionId) {
      set({ isAsking: false, error: "The recipe dataset is still loading." });
      return;
    }

    // Only the words go in the history: the board photo is rebuilt on every
    // ask, so a question asked after an edit is answered against the board as
    // it is now, not as it was when the conversation started.
    const messages: AssistantChatMessage[] = get()
      .turns.filter((turn) => turn.text.length > 0)
      .map((turn) => ({ role: turn.role, text: turn.text }));

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          datasetVersionId,
          messages,
          board: buildAssistantBoardSnapshot(factory.project, factory.lastResult),
        }),
      });
      const payload = (await response.json().catch(() => undefined)) as
        | (AssistantReply & { error?: string })
        | undefined;
      if (!response.ok || !payload || payload.error) {
        set({ isAsking: false, error: payload?.error ?? "The assistant could not answer." });
        return;
      }
      set((state) => ({
        isAsking: false,
        turns: [
          ...state.turns,
          {
            id: nextTurnId++,
            role: "assistant",
            text: payload.text,
            actions: payload.actions.length > 0 ? payload.actions : undefined,
            lookups: payload.lookups.length > 0 ? payload.lookups : undefined,
          },
        ],
      }));
    } catch {
      set({ isAsking: false, error: "The assistant could not be reached." });
    }
  },
}));
