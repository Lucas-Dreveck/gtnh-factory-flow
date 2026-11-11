"use client";

import { useRef, useState } from "react";
import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";

import { ChevronDown, Compass, Library } from "lucide-react";
import { leaveLibrary, openLibrary } from "@/lib/library/library-tab";
import { openWelcomeTab } from "@/lib/welcome/welcome-tab";

/** The header's "Help" dropdown: the auxiliary set of MenuLinks. */
export function HeaderLinks() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDropdownDismiss(open, { refs: [root], onClose: () => setOpen(false) });
  return (
    <div ref={root} className="relative shrink-0">
      <button type="button" aria-expanded={open} aria-label="Help and links"
        onClick={() => setOpen(!open)}
        className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg">
        Help <ChevronDown className="h-3 w-3" />
      </button>
      {open ? <div className="absolute right-0 top-full z-[100] mt-1 w-52 rounded border border-line-strong bg-surface p-1 text-sm shadow-xl">
        <MenuLinks auxiliary onAction={() => setOpen(false)} />
      </div> : null}
    </div>
  );
}

/**
 * The app's links as labelled rows (touch has no hover tooltips), for the
 * compact menu. `auxiliary` (the header's Help dropdown) leaves out Library.
 * No outside links: this instance is private.
 */
export function MenuLinks({ onAction, auxiliary = false }: { onAction?: () => void; auxiliary?: boolean }) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          leaveLibrary();
          openWelcomeTab();
          onAction?.();
        }}
        className="flex h-10 items-center gap-2.5 rounded px-2 text-left text-sm text-fg-subtle hover:bg-surface-sunken"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <Compass className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="truncate">Welcome</span>
      </button>
      {!auxiliary ? <button
        type="button"
        onClick={() => {
          openLibrary();
          onAction?.();
        }}
        className="flex h-10 items-center gap-2.5 rounded px-2 text-left text-sm text-fg-subtle hover:bg-surface-sunken"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <Library className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="truncate">Library</span>
      </button> : null}
    </div>
  );
}
