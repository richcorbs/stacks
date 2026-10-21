#!/usr/bin/env python3
"""Synthetic IPC-dispatch benchmark, NOT a native UI click-to-paint measurement.

Uses disposable real worktrees, the git_info command sequence, and the board's
four-read limit. The dispatcher heartbeat models other work waiting on the IPC
thread. --delay-ms injects filesystem/command latency before each subprocess.
"""
import argparse
import concurrent.futures
import json
import pathlib
import statistics
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--worktrees', type=int, default=8)
parser.add_argument('--untracked', type=int, default=0)
parser.add_argument('--delay-ms', type=int, default=0)
args = parser.parse_args()
if args.worktrees < 1 or args.untracked < 0 or args.delay_ms < 0:
    parser.error('worktrees must be positive; untracked and delay must be nonnegative')


def git(*argv):
    return subprocess.run(['git', *map(str, argv)], check=True, capture_output=True)


with tempfile.TemporaryDirectory(prefix='stacks-git-info-benchmark-') as directory:
    root = pathlib.Path(directory)
    repo = root / 'repo'
    git('init', '-b', 'main', repo)
    git('-C', repo, '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.com',
        'commit', '--allow-empty', '-m', 'base')
    paths = []
    for i in range(args.worktrees):
        path = root / f'worktree-{i}'
        git('-C', repo, 'worktree', 'add', '-b', f'bench-{i}', path)
        for j in range(args.untracked):
            (path / f'file-{j}').touch()
        paths.append(path)

    for mode in ['sync', 'blocking-worker']:
        lock = threading.Lock()
        counters = {'processes': 0, 'running': 0, 'peak': 0}
        card_ms, command_ms = [], []

        def read(path):
            started = time.perf_counter()
            for command in [('branch', '--show-current'),
                            ('status', '--porcelain=v1', '--untracked-files=all')]:
                tick = time.perf_counter()
                with lock:
                    counters['running'] += 1
                    counters['peak'] = max(counters['peak'], counters['running'])
                    counters['processes'] += 1
                time.sleep(args.delay_ms / 1000)
                git('-C', path, *command)
                with lock:
                    counters['running'] -= 1
                    command_ms.append((time.perf_counter() - tick) * 1000)
            with lock:
                card_ms.append((time.perf_counter() - started) * 1000)

        started = time.perf_counter()
        last_heartbeat = started
        heartbeat_gaps = []

        def heartbeat():
            global last_heartbeat
            now = time.perf_counter()
            heartbeat_gaps.append((now - last_heartbeat) * 1000)
            last_heartbeat = now

        if mode == 'sync':
            for path in paths:
                read(path)
                heartbeat()
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(read, path) for path in paths]
                while not all(future.done() for future in futures):
                    time.sleep(0.005)
                    heartbeat()
                for future in futures:
                    future.result()
        heartbeat()
        print(json.dumps({
            'mode': mode, 'worktrees': args.worktrees, 'untracked': args.untracked,
            'injectedDelayMsPerCommand': args.delay_ms,
            'cycleMs': round((time.perf_counter() - started) * 1000, 1),
            'commandP50Ms': round(statistics.median(command_ms), 1),
            'commandMaxMs': round(max(command_ms), 1),
            'cardP50Ms': round(statistics.median(card_ms), 1),
            'dispatcherHeartbeatMaxMs': round(max(heartbeat_gaps), 1),
            'processes': counters['processes'], 'peakCommandSlots': counters['peak'],
        }))
