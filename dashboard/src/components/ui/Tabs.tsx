"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextTabIndex } from "@/lib/tabs";

export interface TabDefinition {
  id: string;
  label: string;
}

interface TabsProps {
  tabs: readonly TabDefinition[];
  activeId: string;
  onChange: (id: string) => void;
  /** Accessible name for the tab list (e.g. "Group sections"). */
  label: string;
  /** Content of the active panel. */
  children: ReactNode;
}

/**
 * WAI-ARIA tabs: roving `tabIndex`, arrow/Home/End navigation, `aria-selected`,
 * and a labelled panel. Only the active panel is rendered, so each tab's data
 * loads on first activation.
 */
export function Tabs({ tabs, activeId, onChange, label, children }: TabsProps) {
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeId),
  );

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const next = nextTabIndex(activeIndex, event.key, tabs.length);
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab === undefined) return;
    onChange(tab.id);
    refs.current[next]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="flex flex-wrap gap-1 border-b border-slate-200"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={selected ? `${baseId}-panel-${tab.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={handleKeyDown}
              className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeId}`}
        aria-labelledby={`${baseId}-tab-${activeId}`}
        tabIndex={0}
        className="mt-6 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        {children}
      </div>
    </div>
  );
}
