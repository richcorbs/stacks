"""JSON-lines PTY driver for the opt-in local reflow comparison (Unix only).
No user shell config or files: bash --noprofile --norc, vim -Nu NONE -n -i NONE.
"""
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid = None
fd = None
decoder = codecs.getincrementaldecoder('utf-8')('replace')


def output():
    chunks = []
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.2)[0]:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(decoder.decode(chunk))
    return ''.join(chunks)


try:
    for line in sys.stdin:
        request = json.loads(line)
        action = request['action']
        if action == 'start':
            pid, fd = pty.fork()
            if pid == 0:
                env = dict(os.environ, TERM='xterm-256color', PS1='REFLOW> ',
                           PROMPT_COMMAND='', LC_ALL='en_US.UTF-8', INPUTRC='/dev/null',
                           HISTFILE='/dev/null')
                shell = os.environ.get('REFLOW_TEST_SHELL', 'bash')
                os.execvpe(shell, [shell, '--noprofile', '--norc', '-i'], env)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', request['rows'], request['cols'], 0, 0))
        elif action == 'write':
            os.write(fd, request['text'].encode('utf-8'))
        elif action == 'resize':
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', request['rows'], request['cols'], 0, 0))
        elif action == 'stop':
            break
        else:
            raise ValueError(action)
        print(json.dumps({'output': output()}), flush=True)
finally:
    if pid:
        # The editor/shell may have separate foreground process groups.
        try:
            os.killpg(os.tcgetpgrp(fd), signal.SIGHUP)
        except (ProcessLookupError, OSError):
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.close(fd)
        os.waitpid(pid, 0)
