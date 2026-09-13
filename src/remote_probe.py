"""Read-only Linux DSH probe, delivered over SSH stdin; no remote installation."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.request


def candidates(data, port):
    pattern = rb'http://127\.0\.0\.1:' + str(port).encode() + rb'/\?token=[A-Za-z0-9._~-]+'
    return list(reversed(dict.fromkeys(x.decode('ascii') for x in re.findall(pattern, data))))


def project_session(item):
    return {key: item[key] for key in ['sessionId', 'cwd', 'running', 'updatedAt', 'blank'] if key in item}


def owner(port):
    sockets = set()
    for table in ['tcp', 'tcp6']:
        for line in (Path('/proc/net') / table).read_text().splitlines()[1:]:
            fields = line.split()
            if int(fields[1].split(':')[1], 16) == port and fields[3] == '0A':
                sockets.add('socket:[' + fields[9] + ']')
    matches = []
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            cmd = (process / 'cmdline').read_bytes()
            if b'dsh' not in cmd:
                continue
            if any(os.readlink(fd) in sockets for fd in (process / 'fd').iterdir()):
                matches.append(process)
        except (OSError, PermissionError):
            continue
    if len(matches) != 1:
        raise RuntimeError('DSH_PROCESS_NOT_UNIQUE')
    return matches[0]


def probe(port, handoff=False):
    process = owner(port)
    fd = process / 'fd/1'
    info = fd.stat()
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError('AUTH_LOG_UNAVAILABLE')
    # Inspect only the process-owned stdout inode, not arbitrary files from its log.
    with fd.open('rb') as stream:
        stream.seek(max(0, info.st_size - 1024 * 1024))
        urls = candidates(stream.read(1024 * 1024), port)
    for url in urls[:20]:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
        try:
            with opener.open(url, timeout=5) as response:
                body = response.read(2 * 1024 * 1024)
            if b'__DSH_BOOT__' not in body or b'DeepSeek Harness' not in body:
                continue
            if owner(port) != process:
                raise RuntimeError('DSH_RESTARTED')
            request = urllib.request.Request('http://127.0.0.1:' + str(port) + '/api/session/list',
                data=json.dumps({'type': 'client-request', 'rpcId': 'ssh-probe', 'method': 'session/list', 'payload': {'args': {'_request': {}}}}).encode(),
                headers={'Content-Type': 'application/json'})
            with opener.open(request, timeout=8) as response:
                payload = response.read(4 * 1024 * 1024 + 1)
            if len(payload) > 4 * 1024 * 1024:
                raise RuntimeError('RESPONSE_TOO_LARGE')
            result = json.loads(payload)['result']
            if not result.get('ok'):
                raise RuntimeError('DSH_API_REJECTED')
            result = {'authenticated': True, 'sessions': [project_session(item) for item in result['value']['items']]}
            # Private SSH stdout only; the host consumes this link and never returns it to the UI.
            if handoff:
                result['loginUrl'] = url
            return result
        except urllib.error.HTTPError:
            continue
    raise RuntimeError('AUTH_URL_UNAVAILABLE')


if __name__ == '__main__':
    try:
        port = int(sys.argv[1])
        if not 1 <= port <= 65535:
            raise ValueError('port')
        print(json.dumps(probe(port, len(sys.argv) == 3 and sys.argv[2] == 'handoff')))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) else 'REMOTE_PROBE_FAILED'
        print(json.dumps({'error': code}))
        sys.exit(1)
