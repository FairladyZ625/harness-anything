"""Ubuntu admission and lifetime owner; invoked only by dispatch-isolated-test.mjs."""
import fcntl
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time

# Reserve CPU headroom on the four-core target; each test runner can use two workers.
CAPACITY = 2


def emit(event, **fields):
    print('[test-isolation-queue] ' + json.dumps(dict(event=event, **fields)), flush=True)


def terminate(group):
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass  # The job already completed; there is no remaining process group.


def cancelled(signum, frame):
    raise SystemExit(128 + signum)


def supervise(workspace, queue):
    queue.mkdir(parents=True, exist_ok=True)
    mutex = open(queue / 'admission.lock', 'a+')
    fcntl.flock(mutex, fcntl.LOCK_EX)
    # Kernel ownership, rather than recorded PIDs, identifies tickets left by
    # a reboot. No live producer/reaper can have its ticket removed here.
    for stale in sorted(p for p in queue.iterdir() if p.name[:1].isdigit()):
        with open(stale, 'r+') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            abandoned = workspace.parent / stale.name.split('-', 1)[1]
            if abandoned.exists():
                shutil.rmtree(abandoned)
            stale.unlink()
    ticket = queue / f'{time.time_ns():020d}-{workspace.name}'
    ticket.touch()
    owner = open(ticket, 'r+')
    fcntl.flock(owner, fcntl.LOCK_EX)
    fcntl.flock(mutex, fcntl.LOCK_UN)
    # A pipe-owned reaper holds the same kernel locks. Even SIGKILL of the SSH
    # supervisor closes the pipe; cleanup finishes before admission is released.
    reader, writer = os.pipe()
    reaper = os.fork()
    if reaper == 0:
        os.close(writer)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for fd in (0, 1, 2):
            os.close(fd)
        group = None
        with os.fdopen(reader) as stream:
            for line in stream:
                group = int(line)
        if group is not None:
            terminate(group)
        if workspace.exists():
            shutil.rmtree(workspace)
        fcntl.flock(mutex, fcntl.LOCK_EX)
        ticket.unlink()
        fcntl.flock(mutex, fcntl.LOCK_UN)
        os._exit(0)
    os.close(reader)
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, cancelled)
    started = time.monotonic()
    child = None
    try:
        # The oldest CAPACITY live tickets own admission until cleanup.
        while True:
            fcntl.flock(mutex, fcntl.LOCK_EX)
            tickets = sorted(p for p in queue.iterdir() if p.name[:1].isdigit())
            position = tickets.index(ticket)
            fcntl.flock(mutex, fcntl.LOCK_UN)
            if position < CAPACITY:
                break
            emit('waiting', run=workspace.name, position=position-CAPACITY+1,
                 capacity=CAPACITY, waited_ms=round((time.monotonic()-started)*1000))
            # Input EOF means the producer was cancelled before admission.
            if select.select([sys.stdin], [], [], 1)[0] and not sys.stdin.buffer.peek(1):
                return 130
        workspace.mkdir()
        emit('admitted', run=workspace.name, capacity=CAPACITY,
             waited_ms=round((time.monotonic()-started)*1000))
        line = sys.stdin.readline()
        if not line:
            return 130
        child = subprocess.Popen(['sh', '-c', json.loads(line)], start_new_session=True, stdin=subprocess.DEVNULL)
        os.write(writer, f'{child.pid}\n'.encode())
        emit('running', run=workspace.name, capacity=CAPACITY, child_pid=child.pid)
        while child.poll() is None:
            if select.select([sys.stdin], [], [], 1)[0] and not sys.stdin.buffer.peek(1):
                return 130
            if round(time.monotonic()-started) % 5 == 0:
                emit('running', run=workspace.name, capacity=CAPACITY)
        emit('finished', run=workspace.name, code=child.returncode)
        # Keep admission through coverage download; EOF also releases the job.
        sys.stdin.readline()
        return child.returncode if child.returncode >= 0 else 128-child.returncode
    finally:
        if child is not None:
            terminate(child.pid)
            child.wait()
        fcntl.flock(mutex, fcntl.LOCK_UN)
        os.close(writer)
        _, status = os.waitpid(reaper, 0)
        if status != 0:
            raise RuntimeError(f'isolation reaper failed: wait status {status}')
        owner.close()
        mutex.close()


if __name__ == '__main__':
    sys.exit(supervise(Path(sys.argv[1]), Path.home() / '.cache' / 'harness-test-isolation-queue'))
