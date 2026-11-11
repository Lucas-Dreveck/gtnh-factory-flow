// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/library/library-sync", () => ({
  adoptRemotePlan: vi.fn(),
  syncLibraryNow: vi.fn(),
}));

import { useCommunityAuthStore } from "@/store/community-auth-store";
import { useDesignStore } from "@/store/design-store";
import { HistoryPanel, relativeTime } from "./HistoryPanel";

afterEach(() => {
  cleanup();
  useCommunityAuthStore.setState({ user: undefined });
  useDesignStore.setState({ activeDesignId: undefined, designs: [] });
});

describe("HistoryPanel", () => {
  it("asks signed-out players to sign in", () => {
    render(<HistoryPanel onClose={() => undefined} />);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("says saving while the design is not on the account yet", () => {
    useCommunityAuthStore.setState({ user: { id: "u", name: "n" } as never });
    useDesignStore.setState({
      activeDesignId: "d1",
      designs: [{ id: "d1", name: "x" } as never],
    });
    render(<HistoryPanel onClose={() => undefined} />);
    expect(screen.getByText(/Saving to your account/)).toBeTruthy();
    expect(screen.queryByText("Create checkpoint")).toBeNull();
  });
});

describe("relativeTime", () => {
  it("reads in minutes and hours", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(relativeTime("2026-01-01T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-01-01T09:00:00Z", now)).toBe("3 h ago");
  });
});
