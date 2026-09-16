export type PhysicalPoint = { x: number; y: number };

export function physicalToCssPoint(position: PhysicalPoint, scaleFactor: number): PhysicalPoint {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return { x: position.x / scale, y: position.y / scale };
}

export function piPaneAtPoint(document: Pick<Document, 'elementFromPoint'>, point: PhysicalPoint): HTMLElement | null {
  return document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('.piGuiPane[data-pi-pane-id]') ?? null;
}

export function terminalPaneAtPoint(document: Pick<Document, 'elementFromPoint'>, point: PhysicalPoint): HTMLElement | null {
  return document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('.terminal[data-terminal-pane-id]') ?? null;
}
