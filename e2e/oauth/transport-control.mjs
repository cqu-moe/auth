import assert from 'node:assert/strict';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';

// Force the stale-notification scheduling race described by upstream Miniflare
// PR #15552 with the real worker-thread primitives, then require the installed
// dependency to contain the same generation handshake as the local backport.
const replyWorkerScript = `
const { parentPort, workerData } = require("node:worker_threads");
const { id, notifyHandle, port, staleWakeCount, startHandle } = workerData;

parentPort.postMessage("ready");
Atomics.wait(startHandle, 0, 0);

let staleWakes = 0;
while (staleWakes < staleWakeCount) {
  if (Atomics.notify(notifyHandle, 0) === 1) staleWakes++;
}
parentPort.postMessage(staleWakes);

port.postMessage({ id, response: { status: 204, headers: {}, body: null } });
Atomics.store(notifyHandle, 0, id + 1);
Atomics.notify(notifyHandle, 0);
port.close();
`;

function receiveWithSharedFlag(notifyHandle, port, id) {
  Atomics.store(notifyHandle, 0, 0);
  Atomics.wait(notifyHandle, 0, 0);
  const message = receiveMessageOnPort(port)?.message;
  assert.equal(message?.id, id);
  return message;
}

function receiveWithGeneration(notifyHandle, port, id) {
  const generation = id + 1;
  for (let seen = Atomics.load(notifyHandle, 0); seen !== generation;
    seen = Atomics.load(notifyHandle, 0)) {
    Atomics.wait(notifyHandle, 0, seen);
  }
  const message = receiveMessageOnPort(port)?.message;
  assert.equal(message?.id, id);
  return message;
}

async function startReplyWorker(id, staleWakeCount) {
  const channel = new MessageChannel();
  const notifyHandle = new Int32Array(new SharedArrayBuffer(4));
  const startHandle = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(replyWorkerScript, {
    eval: true,
    workerData: { id, notifyHandle, port: channel.port2, staleWakeCount, startHandle },
    transferList: [channel.port2],
  });
  const exited = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  const ready = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await ready;
  const staleWakes = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  Atomics.store(startHandle, 0, 1);
  Atomics.notify(startHandle, 0);
  return { channel, exited, notifyHandle, staleWakes };
}

async function runTransportControl() {
  const id = 1;
  const worker = await startReplyWorker(id, 2);
  let sharedFlagFailure;
  let generationReply;
  try {
    try {
      receiveWithSharedFlag(worker.notifyHandle, worker.channel.port1, id);
      throw new Error('shared-flag receiver unexpectedly succeeded');
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      sharedFlagFailure = { name: error.name, message: error.message };
    }
    generationReply = receiveWithGeneration(worker.notifyHandle, worker.channel.port1, id);
    const staleWakes = await worker.staleWakes;
    const exitCode = await worker.exited;
    assert.equal(staleWakes, 2);
    assert.equal(exitCode, 0);
    return { sharedFlagFailure, generationReply, staleWakes };
  } finally {
    worker.channel.port1.close();
    await worker.exited;
  }
}

const protocol = await runTransportControl();
const miniflareManifest = JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8'));
const miniflareSource = await readFile('node_modules/miniflare/dist/src/index.js', 'utf8');
const patched = miniflareManifest.version === '4.20260521.0'
  && miniflareSource.includes('function receiveReply(notifyHandle, port, id)')
  && miniflareSource.includes('Atomics.store(notifyHandle, /* index */ 0, /* generation */ (id + 1) | 0)');
const evidence = {
  schemaVersion: 'auth-oauth-transport-control-1',
  miniflareVersion: miniflareManifest.version,
  dependencyPatched: patched,
  protocol,
  upstreamFix: '6f3d7b58b1f6cd036aca3e5946807bba37776065',
};
const output = process.env.AUTH_OAUTH_TRANSPORT_CONTROL_OUTPUT;
if (output) await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
if (!patched) process.exitCode = 1;
