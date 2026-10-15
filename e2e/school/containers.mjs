import assert from 'node:assert/strict';

// workerd's egress interceptor has its own image and survives mf.dispose().
// Track names from this run's native DO IDs before starting each instance;
// an image-only scan cannot find a proxy after its business object is gone.
export function schoolContainerCleanup({ docker, image, interceptor }) {
  const names = new Set();
  const find = name => docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`]);
  return {
    track(worker, id) {
      assert.match(worker, /^[a-z][a-z0-9-]+$/);
      assert.match(String(id), /^[a-f0-9]{64}$/);
      names.add(`workerd-${worker}-CquLoginContainer-${id}`);
    },
    close() {
      const owned = docker(['ps', '-aq', '--no-trunc', '--filter', `ancestor=${image}`]).split('\n').filter(Boolean);
      if (owned.length) {
        for (const container of JSON.parse(docker(['inspect', ...owned]))) {
          assert.equal(container.Config.Image, image);
          names.add(container.Name.replace(/^\//, ''));
        }
      }
      const proxies = [];
      for (const name of names) {
        const id = find(`${name}-proxy`);
        if (!id) continue;
        assert.match(id, /^[a-f0-9]{64}$/);
        const [proxy] = JSON.parse(docker(['inspect', id]));
        assert.equal(proxy.Name, `/${name}-proxy`);
        assert.equal(proxy.Config.Image, interceptor);
        assert.deepEqual(proxy.Mounts, []);
        proxies.push(id);
      }
      if (owned.length) docker(['rm', '-f', ...owned]);
      for (const id of proxies) {
        docker(['stop', '-t', '2', id]);
        docker(['rm', id]);
      }
      assert.equal(docker(['ps', '-aq', '--filter', `ancestor=${image}`]), '', 'School business containers remain');
      for (const name of names) assert.equal(find(`${name}-proxy`), '', 'School egress proxy remains');
      return { containerObjectsRemoved: true, proxyObjectsRemoved: true,
        removedContainerIds: owned, removedProxyIds: proxies };
    },
  };
}
