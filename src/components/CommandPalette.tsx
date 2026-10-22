import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandPaletteResults } from './CommandPaletteResults';
import { DEFAULT_COMMAND_USAGE, rankEmptyQueryCommands, type CommandUsageCounts } from '../commandPaletteUsage';

export type PaletteItem = {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  /** Overrides display metadata when an item must restrict what is searchable. */
  searchText?: string;
  kind?: 'command' | 'card';
  cardNumber?: string;
  danger?: boolean;
  action: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  items: PaletteItem[];
  cardItems?: PaletteItem[];
  onClose: () => void;
  onRunItem?: () => void;
  usageCounts?: CommandUsageCounts;
  onSelectCommand?: (id: string) => void;
};

export function scorePaletteItem(item: PaletteItem, query: string) {
  const originalQuery = query.trim().toLowerCase();
  if (!originalQuery) return 1;
  const q = item.kind === 'card' ? originalQuery.replace(/^#/, '') : originalQuery;
  if (!q) return 0;
  if (item.kind === 'card' && item.cardNumber?.toLowerCase() === q) return 1_000;

  const haystack = (item.searchText ?? `${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''}`).toLowerCase();
  if (haystack.includes(q)) return 100 - haystack.indexOf(q);
  let index = 0;
  for (const char of q) {
    index = haystack.indexOf(char, index);
    if (index < 0) return 0;
    index += 1;
  }
  return 10;
}

export function filterPaletteItems(commandItems: PaletteItem[], cardItems: PaletteItem[], query: string, usageCounts: CommandUsageCounts = DEFAULT_COMMAND_USAGE) {
  if (!query.trim()) return rankEmptyQueryCommands(commandItems, usageCounts).slice(0, 12);
  const candidates = [...commandItems, ...cardItems];
  return candidates
    .map((item, sourceIndex) => ({ item, sourceIndex, score: scorePaletteItem(item, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)
    .map(({ item }) => item)
    .slice(0, 12);
}

export function CommandPalette({ open, items, cardItems = [], usageCounts = DEFAULT_COMMAND_USAGE, onSelectCommand, onClose, onRunItem }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredItems = useMemo(() => filterPaletteItems(items, cardItems, query, usageCounts), [cardItems, items, query, usageCounts]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind !== 'card') onSelectCommand?.(item.id);
    onRunItem?.();
    if (!onRunItem) onClose();
    item.action();
  };

  return (
    <div className="paletteBackdrop" onMouseDown={onClose}>
      <div className="commandPalette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search commands and cards…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelectedIndex((index) => Math.min(filteredItems.length - 1, index + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelectedIndex((index) => Math.max(0, index - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runItem(filteredItems[selectedIndex]);
            }
          }}
        />
        <div className="paletteResults">
          <CommandPaletteResults
            items={filteredItems}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            onSelectItem={runItem}
          />
        </div>
      </div>
    </div>
  );
}
