import type { RefObject } from 'react';
import type { PiSessionModel } from '../../../pi/usePiSession';
import type { PiPathReferencesModel } from '../pathReferences/usePiPathReferences';
import type { PiComposerModel } from './usePiComposer';
import type { PiComposerKeysModel } from './usePiComposerKeys';

export function PiComposer({ pi, prompt, composerDraftKey, composerError, composer, paths, keys, inputRef }: {
  pi: PiSessionModel;
  prompt: string;
  composerDraftKey?: string;
  composerError: string | null;
  composer: PiComposerModel;
  paths: PiPathReferencesModel;
  keys: PiComposerKeysModel;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  return <div className="piComposer">
    <div className="piComposerRow">
      <div className="piComposerContent">
      {composer.matchingCommands.length > 0 && <div className="piCommandMenu" role="listbox" aria-label="Pi commands">
        {composer.matchingCommands.map((command, index) => <button
          type="button"
          role="option"
          aria-selected={index === composer.selectedCommandIndex}
          className={index === composer.selectedCommandIndex ? 'selected' : ''}
          key={`${command.source}:${command.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => composer.chooseCommand(command)}
        >
          <span><strong>/{command.name}</strong>{command.description && <small>{command.description}</small>}</span>
          <em>{command.source}{command.location ? ` · ${command.location}` : ''}</em>
        </button>)}
      </div>}
      {composer.matchingPaths.length > 0 && <div className="piCommandMenu piPathMenu" role="listbox" aria-label="Workspace files">
        {composer.matchingPaths.map((path, index) => <button
          type="button"
          role="option"
          aria-selected={index === paths.selectedIndex}
          className={index === paths.selectedIndex ? 'selected' : ''}
          key={`${path.isDir ? 'directory' : 'file'}:${path.path}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => composer.choosePath(path)}
        >
          <span><strong>{path.path}{path.isDir ? '/' : ''}</strong></span>
          <em>{path.isDir ? 'directory' : 'file'}</em>
        </button>)}
      </div>}
      {composerError && <div className="piComposerError">{composerError}</div>}
      <textarea
        ref={inputRef}
        data-card-composer={composerDraftKey ? '' : undefined}
        className={prompt.includes('\n') ? undefined : 'singleLine'}
        value={prompt}
        rows={1}
        placeholder={pi.isStreaming ? 'Steer Pi… (↩) · follow up (⌥↩)' : 'Ask Pi…'}
        disabled={pi.starting}
        onSelect={keys.handleSelect}
        onChange={keys.handleChange}
        onKeyDown={keys.handleKeyDown}
      />
      </div>
      {pi.isStreaming ? (
        <button className="piComposerAction stop" type="button" onClick={() => pi.abort().catch(() => {})} title="Stop Pi" aria-label="Stop Pi"><span className="piStopSquare" aria-hidden="true" /></button>
      ) : (
        <button className="piComposerAction" type="button" disabled={!prompt.trim() || pi.starting} onClick={() => composer.submit().catch(console.error)} title="Send" aria-label="Send"><svg className="piSendArrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" /></svg></button>
      )}
    </div>
  </div>;
}

export function PiQuickResponses({ eligible, submitting, onRespond }: {
  eligible: boolean;
  submitting: boolean;
  onRespond: (response: 'yes' | 'no' | 'what do you recommend?') => void;
}) {
  return <div className="piQuickResponses" aria-label="Quick responses">
    <button type="button" disabled={!eligible || submitting} onClick={() => onRespond('yes')}>YES</button>
    <button type="button" disabled={!eligible || submitting} onClick={() => onRespond('no')}>NO</button>
    <button type="button" disabled={!eligible || submitting} onClick={() => onRespond('what do you recommend?')}>RECOMMEND</button>
  </div>;
}
