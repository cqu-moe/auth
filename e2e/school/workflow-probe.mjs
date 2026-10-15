import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

// Platform probe only. Product recovery is covered separately through Auth.
for (let run = 0; run < 2; run++) {
  const mf = new Miniflare({
    modules: true, compatibilityDate: '2026-05-01',
    script: `import { WorkflowEntrypoint } from 'cloudflare:workers';
      export class Probe extends WorkflowEntrypoint {
        async run(event, step) {
          await step.do('write', () => this.env.DB.prepare('INSERT INTO result VALUES (?)').bind(event.payload.value).run());
          return { completed: true };
        }
      }
      export default { async fetch(req, env) {
        if (req.method === 'POST') { await env.JOB.create({id:'probe',params:{value:'workflow-wrote-this'}}); return new Response('queued'); }
        return Response.json(await env.DB.prepare('SELECT value FROM result').all());
      }};`,
    d1Databases: ['DB'], workflows: { JOB: { name: 'probe', className: 'Probe' } },
    outboundService: () => { throw new Error('Unexpected probe egress'); },
  });
  try {
    await (await mf.getD1Database('DB')).prepare('CREATE TABLE result(value TEXT)').run();
    assert.deepEqual((await (await mf.dispatchFetch('http://probe')).json()).results, []);
    assert.equal((await mf.dispatchFetch('http://probe', {method:'POST'})).status, 200);
    let rows;
    for (let i = 0; i < 100; i++) {
      rows = (await (await mf.dispatchFetch('http://probe')).json()).results;
      if (rows.length) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(rows, [{value:'workflow-wrote-this'}]);
    console.log(`Miniflare 4 Workflow -> D1 probe ${run + 1}: passed`);
  } finally { await mf.dispose(); }
}
