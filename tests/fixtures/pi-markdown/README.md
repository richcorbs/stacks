# Pi Markdown transcript fixtures

These are real assistant text blocks captured from local Pi session logs. They are
kept small and feature-diverse so the chat renderer can be checked against actual
streaming output rather than only synthetic Markdown.

- `refined-card-audit.md` — tables, task lists, nested lists, fenced code, long prose.
- `feature-environment-spec.md` — nested task lists, fenced code, long prose.
- `ruby-architecture.md` — many fenced code blocks, tables, nested lists.
- `changes-summary.md` — table, strikethrough, inline code.
- `encompass-research.md` — tables, blockquote, links, fenced code.

Sources (local developer machine):

- `~/.pi/agent/sessions/--Users-rich-Code-arcasa-web-app--/2026-04-26T02-54-52-895Z_019dc7b6-17de-7526-9072-739bd6344c53.jsonl`
- `~/.pi/agent/sessions/--Users-rich-Code-arcasa-web-app--/2026-06-12T15-33-38-786Z_019ebc77-a762-7b80-9df7-f434784fbcae.jsonl`
- `~/.pi/agent/sessions/--Users-rich-Code-oz--/2026-03-14T17-16-19-310Z_03d6ec2d-2544-4480-9ff7-d22fcfb4a73f.jsonl`
- `~/.pi/agent/sessions/--Users-rich-Code-arcasa-web-app-st-1238--/2026-03-31T14-39-45-065Z_052b70c4-b131-4eb1-8fe0-7f4c4d54edde.jsonl`
- `~/Library/Application Support/stacks/pi-sessions/project-direct_2c02ecb1-147d-47e5-8cec-31124e670b5c_agent/2026-10-20T22-08-24-586Z_01a15b5b-ca06-7258-b890-f92d7647e443.jsonl`

Real Pi output in this sample contained no inline HTML outside fenced code, so inline
HTML sanitisation is additionally covered by focused unit tests.
