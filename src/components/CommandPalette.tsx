import { useEffect, useMemo, useRef, useState } from 'react';

export type PaletteItem = {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  danger?: boolean;
  action: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
};

export function scorePaletteItem(item: PaletteItem, query: string) {
  const haystack = `${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (haystack.includes(q)) return 100 - haystack.indexOf(q);
  let index = 0;
  for (const char of q) {
    index = haystack.indexOf(char, index);
    if (index < 0) return 0;
    index += 1;
  }
  return 10;
}

export function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredItems = useMemo(() => items
    .map((item) => ({ item, score: scorePaletteItem(item, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
    .slice(0, 12), [items, query]);

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

  const runSelected = () => {
    const item = filteredItems[selectedIndex];
    if (!item) return;
    onClose();
    item.action();
  };

  return (
    <div className="paletteBackdrop" onMouseDown={onClose}>
      <div className="commandPalette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search commands and terminals…"
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
              runSelected();
            }
          }}
        />
        <div className="paletteResults">
          {filteredItems.length > 0 ? filteredItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`${index === selectedIndex ? 'selected' : ''} ${item.danger ? 'danger' : ''}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => { onClose(); item.action(); }}
            >
              <span>{item.title}</span>
              {item.subtitle && <small>{item.subtitle}</small>}
            </button>
          )) : (
            <div className="paletteEmpty">No matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
