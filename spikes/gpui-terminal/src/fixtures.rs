//! Deterministic fixtures used by the visual golden and manual render checks.

pub fn demo_fixture() -> String {
    let mut text = String::from("\x1b[2J\x1b[H");
    text.push_str("\x1b[38;2;127;179;232m╭─\x1b[0m \x1b[1;38;2;215;225;235mstacks-card-318\x1b[0m \x1b[38;2;110;132;151m~/Code/stacks\x1b[0m \x1b[38;2;112;189;141mgit:(spike)\x1b[0m\r\n");
    text.push_str("\x1b[38;2;127;179;232m╰─\x1b[0m \x1b[38;2;215;225;235m❯\x1b[0m printf '\\033[1mGPUI\\033[0m + \\033[32mlibghostty-vt\\033[0m\\n'\r\n");
    text.push_str("\x1b[1mGPUI\x1b[0m + \x1b[32mlibghostty-vt\x1b[0m\r\n");
    text.push_str("\r\n");
    text.push_str("\x1b[38;2;127;179;232m╭─\x1b[0m \x1b[1mRendering from render.h\x1b[0m\r\n");
    text.push_str("\x1b[38;2;127;179;232m│\x1b[0m  ");
    for i in 0..16 {
        text.push_str(&format!(
            "\x1b[48;2;{};{};{}m  \x1b[0m",
            16 + i * 13,
            22 + i * 8,
            38 + i * 11
        ));
    }
    text.push_str("\r\n");
    text.push_str("\x1b[38;2;127;179;232m│\x1b[0m  \x1b[38;2;204;102;102mred\x1b[0m  \x1b[38;2;209;154;102myellow\x1b[0m  \x1b[38;2;112;189;141mgreen\x1b[0m  \x1b[38;2;129;162;190mblue\x1b[0m  \x1b[38;2;178;148;187mviolet\x1b[0m  \x1b[38;2;92;155;155mcyan\x1b[0m\r\n");
    text.push_str(
        "\x1b[38;2;127;179;232m│\x1b[0m  世界 🙂 e\u{301} ﬁ ✓  ─────────────────────\r\n",
    );
    text.push_str("\x1b[38;2;127;179;232m│\x1b[0m  \x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m \x1b[9mstrike\x1b[0m \x1b[7minverse\x1b[0m\r\n");
    text.push_str("\x1b[38;2;127;179;232m╰─\x1b[0m \x1b[38;2;215;225;235m❯\x1b[0m ");
    text
}

pub fn demo_second_tab() -> String {
    "\x1b[2J\x1b[H\x1b[38;2;127;179;232m╭─\x1b[0m second tab\r\n\x1b[38;2;127;179;232m╰─\x1b[0m ❯ \x1b[38;2;112;189;141mready\x1b[0m\r\n".into()
}
