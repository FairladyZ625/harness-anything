"""Server container admission and lifetime owner; invoked only by dispatch-isolated-test.mjs."""
import fcntl
import json
import os
from pathlib import Path
import select
import shutil
import shlex
import signal
import subprocess
import sys
import time


def emit(event, **fields):
    print('[test-isolation-queue] ' + json.dumps(dict(event=event, **fields)), flush=True)


def terminate(group):
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass  # The job already completed; there is no remaining process group.


def cancelled(signum, frame):
    raise SystemExit(128 + signum)


def cleanup(workspace, container):
    # A container belongs to the engine, not the SSH process group. Name is known
    # before create, including the create/SSH-death race; absence is harmless.
    result = subprocess.run(['docker', 'container', 'ls', '-aq', '--filter', f'name=^/{container}$'],
                            check=True, capture_output=True, text=True)
    if result.stdout.strip():
        subprocess.run(['docker', 'rm', '-f', container], check=True,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    if workspace.exists():
        shutil.rmtree(workspace)


def supervise(run_id, config):
    workspace = Path(config['root']) / 'runs' / run_id
    queue = Path(config['root']) / 'queue'
    capacity = config['capacity']
    workspace.parent.mkdir(parents=True, exist_ok=True)
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
            cleanup(abandoned, abandoned.name)
            stale.unlink()
    ticket = queue / f'{time.time_ns():020d}-{workspace.name}'
    ticket.touch()
    owner = open(ticket, 'r+')
    fcntl.flock(owner, fcntl.LOCK_EX)
    fcntl.flock(mutex, fcntl.LOCK_UN)
    # A pipe-owned reaper holds the same kernel locks. Even SIGKILL of the SSH
    # supervisor closes the pipe; cleanup finishes before admission is released.
    reader, writer = os.pipe()
    ready_reader, ready_writer = os.pipe()
    reaper = os.fork()
    if reaper == 0:
        os.close(writer)
        os.close(ready_reader)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        # stderr stays connected so cleanup failures are observable after the
        # supervisor dies. Do not retain stdout: it would hold the client open.
        for fd in (0, 1):
            os.close(fd)
        group = None
        with os.fdopen(reader) as stream:
            for line in stream:
                message = json.loads(line)
                if 'create' in message:
                    # Creation belongs to this reaper. Caller death cannot race
                    # cleanup against an in-flight engine create request.
                    subprocess.run(message['create'], check=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
                    try:
                        os.write(ready_writer, b'ok\n')
                    except BrokenPipeError:
                        pass  # Owner disconnected during create; EOF still runs cleanup.
                else:
                    group = message['pid']
        if group is not None:
            terminate(group)
        cleanup(workspace, run_id)
        fcntl.flock(mutex, fcntl.LOCK_EX)
        ticket.unlink()
        fcntl.flock(mutex, fcntl.LOCK_UN)
        os._exit(0)
    os.close(reader)
    os.close(ready_writer)
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, cancelled)
    started = time.monotonic()
    child = None
    try:
        # The oldest capacity live tickets own admission until cleanup.
        while True:
            fcntl.flock(mutex, fcntl.LOCK_EX)
            tickets = sorted(p for p in queue.iterdir() if p.name[:1].isdigit())
            position = tickets.index(ticket)
            fcntl.flock(mutex, fcntl.LOCK_UN)
            if position < capacity:
                break
            emit('waiting', run=workspace.name, position=position-capacity+1,
                 capacity=capacity, waited_ms=round((time.monotonic()-started)*1000))
            # Input EOF means the producer was cancelled before admission.
            if select.select([sys.stdin], [], [], 1)[0] and not sys.stdin.buffer.peek(1):
                return 130
        workspace.mkdir()
        emit('admitted', run=workspace.name, capacity=capacity,
             waited_ms=round((time.monotonic()-started)*1000))
        line = sys.stdin.buffer.readline()
        if not line:
            return 130
        remaining = int(line)
        child = subprocess.Popen(['tar', '-xf', '-', '-C', str(workspace)],
                                 start_new_session=True, stdin=subprocess.PIPE)
        os.write(writer, (json.dumps({'pid': child.pid}) + '\n').encode())
        emit('uploading', run=run_id, archive_bytes=remaining)
        while remaining:
            chunk = sys.stdin.buffer.read(min(remaining, 65536))
            if not chunk:
                return 130
            child.stdin.write(chunk)
            remaining -= len(chunk)
        child.stdin.close()
        code = child.wait()
        if code != 0:
            return code
        os.write(writer, b'{"pid": null}\n')
        emit('synced', run=run_id)
        line = sys.stdin.buffer.readline()
        if not line:
            return 130
        (workspace / '.home').mkdir()
        create = [
            'docker', 'create', '--init', '--name', run_id,
            '--cpus', str(config['cpus']), '--memory', f"{config['memoryGiB']}g",
            '--memory-swap', f"{config['memoryGiB']}g",
            '--mount', f'type=bind,source={workspace},target=/workspace',
            '--workdir', '/workspace', '--env', 'HOME=/workspace/.home',
            '--user', f'{os.getuid()}:{os.getgid()}',
            '--entrypoint', 'sh', config['image'], '-c', json.loads(line)
        ]
        emit('creating', run=run_id)
        os.write(writer, (json.dumps({'create': create}) + '\n').encode())
        if os.read(ready_reader, 3) != b'ok\n':
            raise RuntimeError('container creation failed in isolation reaper')
        # The child waits until the reaper owns its process group.
        child = subprocess.Popen(['sh'], start_new_session=True, stdin=subprocess.PIPE)
        os.write(writer, (json.dumps({'pid': child.pid}) + '\n').encode())
        child.stdin.write(('exec ' + shlex.join(['docker', 'start', '-a', run_id]) + '\n').encode())
        child.stdin.close()
        emit('running', run=workspace.name, capacity=capacity, child_pid=child.pid)
        while child.poll() is None:
            if select.select([sys.stdin], [], [], 1)[0] and not sys.stdin.buffer.peek(1):
                return 130
            if round(time.monotonic()-started) % 5 == 0:
                emit('running', run=workspace.name, capacity=capacity)
        code = child.returncode if child.returncode >= 0 else 128-child.returncode
        emit('finished', run=workspace.name, code=code)
        # Keep admission through coverage download; EOF also releases the job.
        sys.stdin.buffer.readline()
        return code
    finally:
        if child is not None:
            terminate(child.pid)
            child.wait()
        fcntl.flock(mutex, fcntl.LOCK_UN)
        os.close(writer)
        os.close(ready_reader)
        _, status = os.waitpid(reaper, 0)
        if status != 0:
            raise RuntimeError(f'isolation reaper failed: wait status {status}')
        owner.close()
        mutex.close()


if __name__ == '__main__':
    with open(sys.argv[2]) as handle:
        config = json.load(handle)
    sys.exit(supervise(sys.argv[1], config))
