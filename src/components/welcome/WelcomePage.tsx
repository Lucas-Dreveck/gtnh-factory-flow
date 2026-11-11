"use client";

import {
  Library,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets";
import { queryRecipeDatasetResources } from "@/lib/datasets/browser-loader";
import { openLibrary } from "@/lib/library/library-tab";
import { openSidebarTab } from "@/lib/sidebar-tab";
import { APP_VERSION } from "@/lib/version";
import { leaveWelcomeTab, setWelcomeOnStartup, useWelcomeTab } from "@/lib/welcome/welcome-tab";
import { writeWorkspaceView } from "@/lib/workspace-view";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { WelcomeBackdrop } from "./WelcomeBackdrop";

/**
 * The Welcome tab. It COVERS the board (see FactoryPlannerApp) rather than
 * replacing it, over a quiet ASCII backdrop. One short column: the name, the
 * ways to start (new design, shared setups, find a recipe, your library) and
 * community setups. Every pick steps off the tab; the checkbox at the foot
 * turns off showing it on startup. Release notes live on the header's
 * version chip, not here.
 */

/** How many of the pack's most-used items the backdrop gets to drift. */
const BACKDROP_ICON_COUNT = 60;

/**
 * The most-used items in the loaded pack, as sprite URLs for the backdrop.
 * Empty until the dataset is known; the backdrop runs without them.
 */
function useBackdropIcons(): string[] {
  const manifest = useFactoryStore((state) => state.datasetManifest);
  const manifestUrl = useFactoryStore((state) => state.datasetManifestUrl);
  const versionId = useFactoryStore((state) => state.selectedDatasetVersionId);
  const version = useMemo(
    () => manifest?.versions.find((entry) => entry.id === versionId),
    [manifest?.versions, versionId],
  );
  const [icons, setIcons] = useState<string[]>([]);
  useEffect(() => {
    if (!version) {
      return;
    }
    const controller = new AbortController();
    queryRecipeDatasetResources(
      manifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
      version,
      { query: "", offset: 0, limit: BACKDROP_ICON_COUNT, kind: "item", sort: "popular" },
      { signal: controller.signal },
    )
      .then((result) => {
        const paths = result.resources
          .map((entry) => entry.iconPath)
          .filter((path): path is string => Boolean(path));
        setIcons(paths);
      })
      .catch(() => {
        // The backdrop is decoration; a failed list leaves it as glyphs.
      });
    return () => controller.abort();
  }, [manifestUrl, version]);
  return icons;
}

export function WelcomePage() {
  const welcome = useWelcomeTab();
  const addDesign = useDesignStore((state) => state.addDesign);
  const backdropIcons = useBackdropIcons();

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-fg">
      <WelcomeBackdrop icons={backdropIcons} />
      {/* A dark wash under the words so the backdrop stays a backdrop; the
          edges are left clear so the animation shows through on both sides
          of the column. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 70% at 50% 40%, rgba(16,20,25,0.92) 0%, rgba(16,20,25,0.7) 55%, rgba(16,20,25,0.05) 100%)",
        }}
      />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-6 pb-8 pt-8 compact:px-4 compact:pt-6">
          <header className="flex flex-col items-start gap-3">
            <div className="flex items-baseline gap-3">
              <h1 className="text-[32px] font-black leading-none tracking-tight text-white compact:text-[26px]">
                <span className="text-cyan-300">GTNH</span> Planner
              </h1>
              <span className="rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted">
                v{APP_VERSION}
              </span>
            </div>
            <p className="max-w-[600px] text-[13px] leading-relaxed text-fg-subtle">
              Draw a GregTech: New Horizons factory as a flowchart. Every card is a
              real recipe, every wire carries a real rate, and the board tells you
              what starves, what clogs and what to build.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <PrimaryButton
                icon={Plus}
                onClick={() => {
                  // Step off first: adding a design does not, and the new
                  // tab would otherwise sit under this page unseen.
                  leaveWelcomeTab();
                  void addDesign();
                }}
              >
                New design
              </PrimaryButton>
              <SecondaryButton
                icon={Search}
                onClick={() => {
                  writeWorkspaceView({ leftPanelOpen: true });
                  openSidebarTab("items", { focusSearch: true });
                }}
              >
                Find a recipe
              </SecondaryButton>
              {/* Your own designs live in the library, not on this page. */}
              <SecondaryButton icon={Library} onClick={() => openLibrary()}>
                Your library
              </SecondaryButton>
            </div>
          </header>

          <footer className="border-t border-line pt-3">
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-fg-muted hover:text-fg">
              <input
                type="checkbox"
                checked={welcome.showOnStartup}
                onChange={(event) => setWelcomeOnStartup(event.target.checked)}
                className="h-3.5 w-3.5 accent-cyan-400"
              />
              Open on this tab when I arrive
            </label>
          </footer>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PrimaryButton({
  icon: Icon,
  onClick,
  children,
}: {
  icon: typeof Plus;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-2 border-2 border-cyan-300 bg-cyan-400 px-3.5 text-[13px] font-bold text-[#062026] shadow-[4px_4px_0_rgba(0,0,0,0.45)] hover:bg-cyan-300 active:translate-x-px active:translate-y-px active:shadow-[2px_2px_0_rgba(0,0,0,0.45)]"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {children}
    </button>
  );
}

function SecondaryButton({
  icon: Icon,
  onClick,
  children,
}: {
  icon: typeof Plus;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-2 border-2 border-line-strong bg-[#151a21]/85 px-3.5 text-[13px] font-bold text-fg-subtle shadow-[4px_4px_0_rgba(0,0,0,0.45)] hover:border-cyan-500/60 hover:text-white active:translate-x-px active:translate-y-px active:shadow-[2px_2px_0_rgba(0,0,0,0.45)]"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {children}
    </button>
  );
}
