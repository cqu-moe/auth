import json, os, pathlib, re, subprocess, time

root = pathlib.Path.cwd()
out = root / '.e2e/control-review'
temp = out / 'native-tmp'
temp.mkdir(exist_ok=True)
temp.chmod(0o700)
assert not subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
env = dict(os.environ, TMPDIR=str(temp) + '/', E2E_TELEMETRY_DISABLED='1', DO_NOT_TRACK='1', WRANGLER_SEND_METRICS='false')
seen = {}
with (out / 'final-self-check.log').open('w') as log:
    child = subprocess.Popen(['node', 'e2e/school/self-check.mjs'], env=env, stdout=log, stderr=subprocess.STDOUT)
    while child.poll() is None:
        for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,args='], text=True).splitlines():
            match = re.search(r'--user-data-dir=([^\s]+)', line)
            if not match or not match[1].startswith(str(temp) + '/'):
                continue
            fields = line.strip().split(None, 2)
            pid, ppid, args = int(fields[0]), int(fields[1]), fields[2]
            seen[pid] = dict(pid=pid, ppid=ppid, profile=match[1], headless='--headless' in args,
                             basic='--password-store=basic' in args, mockKeychain='--use-mock-keychain' in args)
        time.sleep(.1)
    code = child.wait()
alive = []
for pid in seen:
    try:
        os.kill(pid, 0)
        alive.append(pid)
    except ProcessLookupError:
        pass
result = dict(commit=commit, exitCode=code, observations=list(seen.values()), ownedPidsAlive=alive,
              remainingProfiles=[str(p) for p in temp.glob('playwright*profile*')])
(out / 'final-native-driver.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
assert code == 0
assert seen, 'No actual private-profile browser launch observed'
assert not alive and not result['remainingProfiles']
assert all(x['headless'] and x['basic'] and x['mockKeychain'] and not pathlib.Path(x['profile']).exists() for x in seen.values())
