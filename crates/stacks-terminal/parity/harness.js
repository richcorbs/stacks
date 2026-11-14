import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';

let term = null;
let state = { title: '', bells: 0, clipboard: null, keys: [] };

function color(cell, fg) {
  const isRgb = fg ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = fg ? cell.isFgPalette() : cell.isBgPalette();
  const value = fg ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) return { kind: 'rgb', r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
  if (isPalette) return { kind: 'palette', index: value & 0xff };
  return { kind: 'default' };
}

function snapshot() {
  const buffer = term.buffer.active;
  const rows_data = [];
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    const cells = [];
    for (let x = 0; x < term.cols; x += 1) {
      const cell = line ? line.getCell(x) : undefined;
      if (!cell) {
        cells.push({
          text: '', width: 1, fg: { kind: 'default' }, bg: { kind: 'default' },
          bold: false, italic: false, faint: false, underline: false,
          strikethrough: false, inverse: false, invisible: false,
        });
        continue;
      }
      const width = cell.getWidth();
      cells.push({
        // A wide tail's getChars can repeat the base glyph in xterm; the
        // canonical snapshot keeps tail text empty. Invisible cells still
        // carry their chars in xterm's buffer but render nothing.
        text: width === 0 || cell.isInvisible() ? '' : cell.getChars(),
        width,
        fg: color(cell, true),
        bg: color(cell, false),
        bold: !!cell.isBold(),
        italic: !!cell.isItalic(),
        faint: !!cell.isDim(),
        underline: !!cell.isUnderline(),
        strikethrough: !!cell.isStrikethrough(),
        inverse: !!cell.isInverse(),
        invisible: !!cell.isInvisible(),
      });
    }
    const text = cells.map((cell) => (cell.width === 0 ? '' : (cell.text || ' '))).join('').trimEnd();
    rows_data.push({ text, cells });
  }
  const core = term._core;
  const cursorHidden = core?._coreService?.isCursorHidden;
  return {
    cols: term.cols,
    rows: term.rows,
    screen: buffer.type === 'alternate' ? 'alternate' : 'normal',
    cursor: {
      x: buffer.cursorX,
      y: buffer.cursorY,
      visible: typeof cursorHidden === 'boolean' ? !cursorHidden : null,
    },
    scrollbar_total: buffer.length,
    scrollbar_offset: buffer.viewportY,
    title: state.title,
    bells: state.bells,
    clipboard: state.clipboard,
    rows_data,
  };
}

window.parity = {
  init(cols, rows) {
    if (term) { term.dispose(); term = null; }
    state = { title: '', bells: 0, clipboard: null, keys: [] };
    const host = document.getElementById('host');
    host.innerHTML = '';
    term = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 100000,
      fontFamily: 'Menlo',
      fontSize: 14,
      minimumContrastRatio: 1,
      macOptionIsMeta: true,
      reflowCursorLine: true,
      theme: { background: '#0f141b', foreground: '#f0f4fc' },
    });
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.onTitleChange((title) => { state.title = title; });
    term.onBell(() => { state.bells += 1; });
    term.onData((data) => { state.keys.push(data); });
    term.parser.registerOscHandler(52, (data) => {
      const parts = data.split(';');
      const encoded = parts[parts.length - 1] || '';
      try {
        state.clipboard = atob(encoded);
      } catch {
        state.clipboard = encoded;
      }
      return true;
    });
    term.open(host);
    return true;
  },
  async write(text) {
    await new Promise((resolve) => term.write(text, resolve));
    return true;
  },
  async writeBytes(base64) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    await new Promise((resolve) => term.write(bytes, resolve));
    return true;
  },
  async resize(cols, rows) {
    term.resize(cols, rows);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  },
  get term() { return term; },
  select(startX, startY, endX, endY) {
    const length = (endY * term.cols + endX) - (startY * term.cols + startX) + 1;
    term.select(startX, startY, length);
    return term.getSelection();
  },
  async paste(text) {
    state.keys = [];
    term.paste(text);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return state.keys.join('');
  },
  resetKeys() { state.keys = []; },
  keys() { return state.keys; },
  palette() {
    const ansi = term._core._themeService.colors.ansi;
    return ansi.map((entry) => {
      const rgba = entry.rgba >>> 0;
      return [(rgba >>> 24) & 0xff, (rgba >>> 16) & 0xff, (rgba >>> 8) & 0xff];
    });
  },
  snapshot,
  dispose() { if (term) { term.dispose(); term = null; } },
};
