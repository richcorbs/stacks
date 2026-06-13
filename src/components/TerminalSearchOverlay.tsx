import { useEffect, useRef } from 'react';

export function TerminalSearchOverlay({ value, resultText, onChange, onNext, onPrevious, onClose }: {
  value: string;
  resultText: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  return (
    <div
      className="terminalSearch"
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <input
        ref={inputRef}
        value={value}
        placeholder="Search terminal"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrevious();
            else onNext();
          }
        }}
      />
      <span className="terminalSearchCount">{resultText}</span>
      <button type="button" onClick={onPrevious} title="Previous match">↑</button>
      <button type="button" onClick={onNext} title="Next match">↓</button>
    </div>
  );
}
