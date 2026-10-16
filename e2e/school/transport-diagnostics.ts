import { readdir } from 'node:fs/promises';
import type { BrowserContext, Request } from 'playwright-core';

// Observation only: no routing, request overrides, retries or response/body reads.
// These bounded records pass through the existing private -> redact -> scan publisher.
export async function observeSchoolTransport(context: BrowserContext) {
  const assets = (await readdir('frontend/dist/assets')).filter(name => /^[\w-]+\.js$/.test(name));
  const requests = new WeakMap<Request, number>();
  let sequence = 0;
  const emit = (event: string, detail: Record<string, unknown> = {}) =>
    console.info('AUTH_SCHOOL_TRANSPORT ' + JSON.stringify({ side: 'browser', event, at: Date.now(), ...detail }));
  context.on('request', request => {
    if (request.method() !== 'PUT' || new URL(request.url()).pathname !== '/api/v1/cqu/binding/credentials') return;
    requests.set(request, ++sequence);
    emit('request', { id: sequence });
  });
  context.on('response', response => {
    const id = requests.get(response.request());
    if (id) emit('response', { id, status: response.status() });
  });
  context.on('requestfinished', request => {
    const id = requests.get(request);
    if (id) emit('finished', { id });
  });
  context.on('requestfailed', request => {
    const id = requests.get(request);
    if (!id) return;
    const code = request.failure()?.errorText;
    emit('failed', { id, code: ['NS_ERROR_ABORT', 'NS_BINDING_ABORTED', 'net::ERR_ABORTED'].includes(code ?? '') ? code : 'other' });
  });
  const watch = (page: ReturnType<BrowserContext['pages']>[number]) => {
    page.on('framenavigated', frame => {
      if (!sequence || frame !== page.mainFrame()) return;
      const path = new URL(frame.url()).pathname;
      emit('navigation', { page: ['/cqu/bind', '/login', '/settings'].includes(path) ? path : 'other' });
    });
    page.on('close', () => { if (sequence) emit('page-close'); });
    page.on('crash', () => { if (sequence) emit('page-crash'); });
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  context.on('close', () => { if (sequence) emit('context-close'); });
  await context.addInitScript(({ assets }) => {
    const records = new WeakMap<AbortSignal, number>();
    let sequence = 0, count = 0;
    const emit = (event: string, detail: Record<string, unknown> = {}) => {
      if (count++ < 128) console.info('AUTH_SCHOOL_TRANSPORT ' + JSON.stringify({ side: 'page', event, at: Date.now(), ...detail }));
    };
    const errorName = (error: unknown) => {
      const name = (error as { name?: string } | null)?.name;
      return ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(name ?? '') ? name : 'other';
    };
    // Keep only built asset names and numeric positions; never error messages,
    // function names, query strings, headers, bodies, signal reasons or raw stacks.
    const callsite = () => [...(new Error().stack ?? '').matchAll(/(https?:\/\/[^\s()]+):(\d+):(\d+)/g)]
      .flatMap(match => {
        const url = new URL(match[1]);
        const file = url.pathname.slice('/assets/'.length);
        return url.origin === location.origin && url.pathname.startsWith('/assets/') && assets.includes(file)
          ? [{ file, line: Number(match[2]), column: Number(match[3]) }] : [];
      }).slice(0, 6);
    const abort = AbortController.prototype.abort;
    AbortController.prototype.abort = function (...args) {
      const id = records.get(this.signal);
      if (id) emit('abort-call', { id, frames: callsite() });
      return Reflect.apply(abort, this, args);
    };
    const fetch = window.fetch;
    window.fetch = function (input, init) {
      // The production apiRequest call uses this relative string and method.
      // Leave every other fetch input untouched, including invalid inputs.
      if (input !== '/api/v1/cqu/binding/credentials' || init?.method !== 'PUT') {
        return Reflect.apply(fetch, this, [input, init]);
      }
      const id = ++sequence;
      const signal = init.signal;
      emit('fetch', { id, hasSignal: Boolean(signal), aborted: signal?.aborted ?? false });
      if (signal) {
        records.set(signal, id);
        signal.addEventListener('abort', () => emit('signal-abort', { id, reason: errorName(signal.reason) }), { once: true });
      }
      return Reflect.apply(fetch, this, [input, init]).then(response => {
        emit('fetch-response', { id, status: response.status, aborted: signal?.aborted ?? false });
        return response;
      }, error => {
        emit('fetch-failed', { id, error: errorName(error), aborted: signal?.aborted ?? false });
        throw error;
      });
    };
    for (const event of ['beforeunload', 'pagehide', 'popstate', 'hashchange']) {
      addEventListener(event, () => { if (sequence) emit(event); });
    }
  }, { assets });
}
