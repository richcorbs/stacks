#!/bin/sh
# Demo stand-in for the Pi TUI. Proves the TUI owns a real PTY and passes
# project/card/thread/socket context without touching model credentials.
printf '\033[2J\033[H'
printf 'Fake Pi TUI (demo)\n'
printf 'project=%s\n' "$STACKS_PROJECT_NAME"
printf 'card=%s thread=%s\n' "$STACKS_CARD_ID" "$STACKS_CARD_THREAD"
printf 'socket=%s\n' "$STACKS_AUTOMATION_SOCKET"
printf 'args: %s\n' "$*"
sleep 30
