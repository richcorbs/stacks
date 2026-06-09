import { useRef } from 'react';

export function SplitResizeHandle({ direction, onResize }: {
  direction: 'row' | 'column';
  onResize: (ratio: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={ref}
      className={`splitResizeHandle splitResizeHandle-${direction}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const split = ref.current?.parentElement;
        if (!split) return;
        const rect = split.getBoundingClientRect();
        const update = (event: PointerEvent) => {
          const raw = direction === 'row'
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - rect.top) / rect.height;
          onResize(Math.min(0.9, Math.max(0.1, raw)));
        };
        const stop = () => {
          window.removeEventListener('pointermove', update);
          window.removeEventListener('pointerup', stop);
          document.body.classList.remove('resizingSplit');
        };
        document.body.classList.add('resizingSplit');
        window.addEventListener('pointermove', update);
        window.addEventListener('pointerup', stop);
      }}
    />
  );
}
