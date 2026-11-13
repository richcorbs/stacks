use ghostty_vt::key::{Action, Key, Mods};
use stacks_gpui_terminal_spike::terminal_model::TerminalModel;

fn model(cols: u16, rows: u16) -> TerminalModel {
    TerminalModel::new(cols, rows, 2_000_000).unwrap()
}

#[test]
fn width_table_divergences_are_recorded() {
    let mut term = model(40, 4);
    term.feed("A世界🙂e\u{301}Z·✓\u{1f1fa}\u{1f1f8}".as_bytes());
    let frame = term.frame().unwrap();
    let cell = |x| frame.cell(x, 0).unwrap();

    // Ghostty's built-in width table, not xterm.js unicode11.
    assert!(!cell(0).wide, "ASCII");
    assert!(cell(1).wide && cell(3).wide, "CJK ideographs are two cells");
    assert_eq!(cell(1).text.as_str(), "世");
    assert_eq!(cell(2).spacer_tail, true, "wide tail is a spacer");
    assert!(cell(5).wide, "emoji is two cells in Ghostty");
    assert_eq!(cell(5).text.as_str(), "🙂");
    assert_eq!(
        cell(7).text.as_str(),
        "e\u{301}",
        "combining mark stays in one cell"
    );
    assert_eq!(cell(8).text.as_str(), "Z");
    // Middle dot (U+00B7) is narrow; check mark (U+2713) is narrow.
    assert_eq!(cell(9).text.as_str(), "·");
    assert!(!cell(9).wide);
    assert_eq!(cell(10).text.as_str(), "✓");
    assert!(!cell(10).wide);
    // Regional indicators form one flag cluster in Ghostty's grapheme handling.
    assert_eq!(cell(11).text.as_str(), "\u{1f1fa}\u{1f1f8}");
    assert!(cell(11).wide);
}

#[test]
fn reflow_keeps_logical_rows_and_cursor_consistent() {
    let mut term = model(20, 5);
    term.feed(b"abcdefghijklmnopqrstuvwxyz0123456789");
    assert_eq!(term.frame().unwrap().row_text(0), "abcdefghijklmnopqrst");
    assert_eq!(term.frame().unwrap().row_text(1), "uvwxyz0123456789");

    term.resize(10, 5, 8, 18).unwrap();
    let text = term.frame().unwrap().text();
    assert_eq!(text[0], "abcdefghij");
    assert_eq!(text[1], "klmnopqrst");
    assert_eq!(text[2], "uvwxyz0123");
    assert_eq!(text[3], "456789");
    let cursor = term.frame().unwrap().cursor.unwrap();
    // Reflow does not leave the cursor on a stale physical row.
    assert!(cursor.y >= 3);

    term.resize(20, 5, 8, 18).unwrap();
    let text = term.frame().unwrap().text();
    assert_eq!(text[0], "abcdefghijklmnopqrst");
    assert_eq!(text[1], "uvwxyz0123456789");
}

#[test]
fn wide_glyph_at_right_margin_wraps_without_clipping() {
    let mut term = model(10, 4);
    // Nine narrow cells leaves only one cell; a two-cell glyph must wrap.
    term.feed("123456789世".as_bytes());
    let frame = term.frame().unwrap();
    assert_eq!(frame.row_text(0), "123456789");
    assert_eq!(frame.row_text(1), "世");
    assert!(frame.cell(0, 1).unwrap().wide);
}

#[test]
fn alternate_screen_does_not_reflow() {
    let mut term = model(20, 4);
    term.feed(b"\x1b[?1049h\x1b[2J\x1b[HABCDEFGHIJKLMNOPQRST");
    assert_eq!(term.frame().unwrap().row_text(0), "ABCDEFGHIJKLMNOPQRST");
    term.resize(10, 4, 8, 18).unwrap();
    assert_eq!(term.frame().unwrap().row_text(0), "ABCDEFGHIJ");
}

#[test]
fn truecolor_palette_and_inverse_are_materialized() {
    let mut term = model(20, 4);
    term.feed(b"\x1b[38;2;12;34;56m\x1b[48;2;200;210;220mtrue\x1b[0m \x1b[7minv\x1b[0m");
    let frame = term.frame().unwrap();
    let cell = frame.cell(0, 0).unwrap();
    assert_eq!((cell.fg.r, cell.fg.g, cell.fg.b), (12, 34, 56));
    assert_eq!((cell.bg.r, cell.bg.g, cell.bg.b), (200, 210, 220));
    let inverse = frame.cell(5, 0).unwrap();
    assert_eq!(
        (inverse.fg.r, inverse.fg.g, inverse.fg.b),
        (0x0f, 0x14, 0x1b)
    );
    assert_eq!(
        (inverse.bg.r, inverse.bg.g, inverse.bg.b),
        (0xf0, 0xf4, 0xfc)
    );
}

#[test]
fn clipboard_osc52_title_bell_and_bracketed_paste() {
    let mut term = model(20, 3);
    let effects = term.feed(b"\x07\x1b]2;title\x1b\\\x1b]52;c;aGVsbG8=\x07");
    assert_eq!(effects.bells, 1);
    assert_eq!(effects.titles, ["title"]);
    assert_eq!(effects.clipboard, ["hello"]);
    assert_eq!(term.encode_paste("hello\nworld").unwrap(), b"hello\rworld");
    term.feed(b"\x1b[?2004h");
    assert_eq!(
        term.encode_paste("hello\nworld").unwrap(),
        b"\x1b[200~hello\rworld\x1b[201~"
    );
}

#[test]
fn ghostty_encodes_ctrl_alt_and_kitty_keys() {
    let mut term = model(20, 3);
    assert_eq!(
        term.encode_key(Key::C, Mods::CTRL, Action::Press, None, None, false)
            .unwrap(),
        vec![3]
    );
    assert_eq!(
        term.encode_key(
            Key::B,
            Mods::ALT,
            Action::Press,
            Some("b"),
            Some('b'),
            false
        )
        .unwrap(),
        b"\x1bb"
    );
    assert_eq!(
        term.encode_key(Key::A, Mods::CTRL, Action::Press, None, None, false)
            .unwrap(),
        vec![1]
    );
    // Kitty keyboard protocol is enabled by the running program.
    term.feed(b"\x1b[>1u");
    let encoded = term
        .encode_key(
            Key::A,
            Mods::CTRL | Mods::SHIFT,
            Action::Press,
            Some("A"),
            Some('a'),
            false,
        )
        .unwrap();
    assert!(!encoded.is_empty());
}
