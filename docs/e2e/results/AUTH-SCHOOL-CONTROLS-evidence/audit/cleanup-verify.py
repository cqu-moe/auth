import json, os, pathlib, subprocess

root = pathlib.Path.cwd()
out = root / '.e2e/control-review'
images = []
for run in ['school-negative-1792087862645', 'school-negative-1792087982965']:
    for control in ['assertion', 'zero']:
        meta = json.loads((root / '.e2e' / run / control / 'mobile/runtime.json').read_text())
        assert meta['cleanup'] == 'passed' and meta['resources']['directoryRemoved'] is True
        platform = meta['resources']['platform']
        assert platform['containerObjectsRemoved'] and platform['proxyObjectsRemoved'] and platform['fixtureImageRemoved']
        assert platform['removedContainerIds'] == [] and platform['removedProxyIds'] == []
        image = platform['imageId']
        result = subprocess.run(['docker', 'image', 'inspect', image], text=True, capture_output=True)
        assert result.returncode == 1 and 'No such image' in result.stderr, result.stderr
        instances = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'ancestor=' + image], text=True).strip()
        assert not instances
        images.append(dict(run=run, control=control, imageId=image, imageAbsent=True, businessObjectsAbsent=True,
                           removedContainerIds=platform['removedContainerIds'], removedProxyIds=platform['removedProxyIds']))
driver = json.loads((out / 'final-native-driver.json').read_text())
for record in driver['observations']:
    try:
        os.kill(record['pid'], 0)
        raise AssertionError('Owned browser PID remains')
    except ProcessLookupError:
        pass
    assert not pathlib.Path(record['profile']).exists()
runtime_dirs = [str(p) for p in root.glob('.auth-e2e-*')]
assert not runtime_dirs
result = dict(result='passed', images=images, observedBrowserPidsAbsent=[r['pid'] for r in driver['observations']], runtimeDirectories=runtime_dirs,
              note='Pre-secret and zero controls create fixture images but no school business/proxy instances; empty removed-ID arrays are expected, not full binding cleanup proof.')
(out / 'cleanup-verify.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(dict(result='passed', removedImagesVerified=len(images), observedPidsAbsent=len(driver['observations']))))
