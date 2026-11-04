"use client";

import type { Group } from "@summarly/contracts";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

const INPUT_CLASSES =
  "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm " +
  "placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 " +
  "focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

/**
 * Type-to-filter group picker for the summary request form. Keeps the
 * form's selected `value` while letting the admin narrow a long group
 * list as they type. Keyboard: Up/Down, Enter, Escape.
 */
export function GroupCombobox({
  groups,
  value,
  onChange,
  disabled = false,
  error,
}: {
  groups: readonly Group[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const selected = groups.find((group) => group.id === value);
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputId = useId();
  const listId = useId();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return groups;
    return groups.filter((group) =>
      group.name.toLowerCase().includes(needle),
    );
  }, [groups, query]);

  // Keep the closed input showing the selected group's name.
  useEffect(() => {
    if (!open) setQuery(selected?.name ?? "");
  }, [open, selected?.name]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent): void {
      if (
        rootRef.current !== null &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function commit(group: Group): void {
    onChange(group.id);
    setQuery(group.name);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) =>
        filtered.length === 0 ? 0 : Math.min(index + 1, filtered.length - 1),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const group = filtered[activeIndex];
      if (group !== undefined) commit(group);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setQuery(selected?.name ?? "");
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
        Group<span className="text-red-700"> *</span>
      </label>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && filtered[activeIndex] !== undefined
            ? `${listId}-${filtered[activeIndex].id}`
            : undefined
        }
        aria-invalid={error === undefined ? undefined : true}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={(event) => {
          setOpen(true);
          event.currentTarget.select();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Type to search groups…"
        disabled={disabled}
        autoComplete="off"
        className={`${INPUT_CLASSES} ${
          error === undefined ? "border-slate-300" : "border-red-400"
        }`}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Groups"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-raised"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500">
              No groups match.
            </li>
          ) : (
            filtered.map((group, index) => (
              <li
                key={group.id}
                id={`${listId}-${group.id}`}
                role="option"
                aria-selected={group.id === value}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(group);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm ${
                  index === activeIndex ? "bg-brand-50 text-brand-900" : "text-slate-700"
                } ${group.id === value ? "font-semibold" : ""}`}
              >
                <span className="min-w-0 truncate">{group.name}</span>
                {group.monitored ? (
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-emerald-700">
                    Monitored
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
      {error === undefined ? null : (
        <p className="mt-1 text-xs font-medium text-red-700">{error}</p>
      )}
    </div>
  );
}
