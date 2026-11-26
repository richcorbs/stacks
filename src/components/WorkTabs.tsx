import type { WorkTab } from '../workSurface';

/**
 * The one tab strip. Hosts supply labels, disabled/running state and order;
 * Diff's split label/refresh control and the class names live here.
 */
export function WorkTabs<T extends string>({ activeView, tabs, ariaLabel, onSelect, onRefreshDiff }: {
  activeView: T;
  tabs: WorkTab<T>[];
  ariaLabel: string;
  onSelect: (view: T) => unknown;
  onRefreshDiff?: () => void;
}) {
  return <nav className="cardWorkspaceTabs" aria-label={ariaLabel}>
    {tabs.map((tab) => tab.view === 'diff'
      ? <span key={tab.view} className={`cardDiffTab${activeView === tab.view ? ' active' : ''}`}>
        <button className="cardDiffTabLabel" type="button" disabled={tab.disabled} title={tab.disabledTitle} onClick={() => onSelect(tab.view)}>{tab.label}</button>
        <button className="cardDiffRefresh" type="button" disabled={tab.refreshDisabled ?? tab.disabled} aria-label="Refresh diff" title={tab.refreshTitle} onClick={onRefreshDiff}><span className="diffRefreshIcon" aria-hidden="true" /></button>
      </span>
      : <button key={tab.view} className={activeView === tab.view ? 'active' : ''} type="button" disabled={tab.disabled} title={tab.disabledTitle}
        aria-label={tab.running ? 'Terminal, server or console running' : undefined}
        onClick={() => onSelect(tab.view)}>{tab.running === undefined ? tab.label : <>{tab.label}{tab.running && <span className="cardTabRunningDot" title="Server or console running" aria-hidden="true" />}</>}</button>)}
  </nav>;
}
