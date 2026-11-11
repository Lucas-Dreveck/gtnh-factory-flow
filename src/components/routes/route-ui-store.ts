import { create } from "zustand";

/**
 * Which route-alternative sheets are open. Kept out of the plan on purpose:
 * it is screen state, and the board's context menu (which unmounts the moment
 * it fires) has to be able to ask for them.
 */
interface RouteUiState {
  panelOpen: boolean;
  /** The choice the panel opens on. */
  focusChoiceId?: string;
  /** Board ids waiting to become an option; the "new comparison" sheet is open while set. */
  pendingBoardIds?: string[];
  /** The comparison that should solve itself when the panel opens (a route just added). */
  autoCompareChoiceId?: string;
  /** The "Find other routes" sheet. */
  finderOpen: boolean;
  /** Resource and card the sheet was opened for (a card's menu fills both). */
  finderTarget?: { kind: "item" | "fluid"; id: string };
  finderNodeId?: string;
  openFinder: (target?: { kind: "item" | "fluid"; id: string }, nodeId?: string) => void;
  closeFinder: () => void;
  openPanel: (choiceId?: string, options?: { compare?: boolean }) => void;
  closePanel: () => void;
  askNewOption: (boardIds: string[]) => void;
  closeNewOption: () => void;
}

export const useRouteUi = create<RouteUiState>((set) => ({
  panelOpen: false,
  finderOpen: false,
  openFinder: (target, nodeId) => set({ finderOpen: true, finderTarget: target, finderNodeId: nodeId }),
  closeFinder: () => set({ finderOpen: false }),
  openPanel: (choiceId, options) =>
    set({ panelOpen: true, focusChoiceId: choiceId, autoCompareChoiceId: options?.compare ? choiceId : undefined }),
  closePanel: () => set({ panelOpen: false }),
  askNewOption: (boardIds) => set({ pendingBoardIds: boardIds }),
  closeNewOption: () => set({ pendingBoardIds: undefined }),
}));
