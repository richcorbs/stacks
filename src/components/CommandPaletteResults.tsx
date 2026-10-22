import type { PaletteItem } from './CommandPalette';

export function CommandPaletteResults({
  items,
  selectedIndex,
  setSelectedIndex,
  onSelectItem,
}: {
  items: PaletteItem[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  onSelectItem: (item: PaletteItem) => void;
}) {
  if (items.length === 0) return <div className="paletteEmpty">No matches</div>;

  return items.map((item, index) => (
    <button
      key={item.id}
      type="button"
      className={`${index === selectedIndex ? 'selected' : ''} ${item.danger ? 'danger' : ''}`}
      onMouseEnter={() => setSelectedIndex(index)}
      onClick={() => onSelectItem(item)}
    >
      <span>{item.title}</span>
      {item.subtitle && <small>{item.subtitle}</small>}
    </button>
  ));
}
