import { useEffect, useRef } from 'react';

export function ProjectNotesView({ projectName, notes, onChange, onClose }: {
  projectName: string;
  notes: string;
  onChange: (notes: string) => void;
  onClose: () => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  return (
    <section className="projectNotes" aria-label={`Notes for ${projectName}`}>
      <header className="projectNotesHeader">
        <div>
          <strong>Project Notes</strong>
          <span>{projectName}</span>
        </div>
        <span>Saved automatically · ⇧⌘O to close</span>
      </header>
      <textarea
        ref={editorRef}
        value={notes}
        aria-label={`Notes for ${projectName}`}
        placeholder="Keep project notes, commands, links, and reminders here…"
        spellCheck
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onClose();
        }}
      />
    </section>
  );
}
