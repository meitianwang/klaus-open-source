import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserError, type BrowserObject } from '../main/browser/types';
import {
  NativeNavigationGate,
  NativeNavigationLeases,
  type NativeNavigationCdp,
} from '../main/browser/native-navigation';

class FakeCdp implements NativeNavigationCdp {
  readonly commands: Array<{ method: string; params?: BrowserObject; frame?: string }> = [];
  private readonly listeners = new Set<(method: string, params: BrowserObject, frame?: string) => void>();

  constructor(private readonly mainFrameId = 'main') {}

  async command(method: string, params: BrowserObject = {}, frame?: string): Promise<BrowserObject> {
    this.commands.push({ method, params, frame });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: this.mainFrameId } } } as BrowserObject;
    return {};
  }

  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(method: string, params: BrowserObject, frame?: string): void {
    for (const listener of [...this.listeners]) listener(method, params, frame);
  }

  calls(method: string): Array<{ method: string; params?: BrowserObject; frame?: string }> {
    return this.commands.filter(call => call.method === method);
  }

  get listenerCount(): number { return this.listeners.size; }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('condition was not reached');
}

function pausedRequest(
  id: string,
  url: string,
  options: { frameId?: string; method?: string; postData?: string; redirectedRequestId?: string } = {},
): BrowserObject {
  return {
    requestId: id,
    frameId: options.frameId ?? 'main',
    resourceType: 'Document',
    ...(options.redirectedRequestId ? { redirectedRequestId: options.redirectedRequestId } : {}),
    request: {
      url,
      method: options.method ?? 'POST',
      postData: options.postData ?? 'payload',
      headers: { 'content-type': 'text/plain' },
    },
  };
}

test('browser-owned main frame identity gates the initial popup without a renderer frame-tree request', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  const lease = leases.begin('popup-owner', 1, 'other', undefined, true);
  const authorized: string[] = [];
  const gate = new NativeNavigationGate({ sessionId: 'popup-owner', pageHandle: 1, cdp, leases,
    mainFrameId: () => 'main', assertNavigation: value => String(value),
    authorize: (_session, url) => { authorized.push(url); } });
  await gate.start();
  assert.equal(cdp.calls('Page.getFrameTree').length, 0);
  cdp.emit('Fetch.requestPaused', pausedRequest('popup-first', 'https://example.com/popup'));
  await until(() => cdp.calls('Fetch.continueRequest').length === 1);
  assert.deepEqual(authorized, ['https://example.com/popup']);
  assert.equal(gate.takeVisitSource('https://example.com/popup'), 'other');
  lease.release(); await gate.stop();
});

test('main-frame requests authorize every hop and preserve the original method and body', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  const authorized: string[] = [];
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async (_sessionId, url) => { authorized.push(url); },
  });
  await gate.start();
  assert.deepEqual(cdp.calls('Fetch.enable')[0]?.params, {
    patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
  });
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await flush();
  cdp.emit('Fetch.requestPaused', pausedRequest('r2', 'https://example.test/next', { redirectedRequestId: 'r1' }));
  await flush();

  assert.deepEqual(authorized, ['https://example.test/start', 'https://example.test/next']);
  assert.deepEqual(cdp.calls('Fetch.continueRequest').map(call => call.params), [
    { requestId: 'r1' },
    { requestId: 'r2' },
  ], 'continue must not override URL, method, headers or postData');
  assert.equal(gate.takeVisitSource('https://example.test/start'), 'agent');
  assert.equal(gate.takeVisitSource('https://example.test/next'), 'agent');
  lease.release();
  await gate.stop();
});

test('a denied redirect target is failed and never continued', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async (_sessionId, url) => {
      if (url.endsWith('/blocked')) throw new BrowserError('refused_by_policy', 'blocked target');
    },
  });
  await gate.start();
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await flush();
  cdp.emit('Fetch.requestPaused', pausedRequest('r2', 'https://example.test/blocked', { redirectedRequestId: 'r1' }));
  await flush();

  assert.deepEqual(cdp.calls('Fetch.continueRequest').map(call => call.params), [{ requestId: 'r1' }]);
  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r2', errorReason: 'BlockedByClient' },
  ]);
  assert.equal(gate.takeVisitSource('https://example.test/blocked'), undefined);
  lease.release();
  await gate.stop();
});

test('visit source follows the active lease without a time window', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  const authorized: string[] = [];
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async (_sessionId, url) => { authorized.push(url); },
  });
  await gate.start();
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/agent'));
  await flush();
  lease.release();
  cdp.emit('Fetch.requestPaused', pausedRequest('r2', 'https://example.test/human'));
  await flush();

  assert.deepEqual(authorized, ['https://example.test/agent']);
  assert.equal(gate.takeVisitSource('https://example.test/agent'), 'agent');
  assert.equal(gate.takeVisitSource('https://example.test/human'), 'other');
  assert.equal(leases.current('session-1', 1), undefined);
  await gate.stop();
});

test('abortPending releases paused requests and ignores late authorization', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  let started!: () => void;
  const authorizationStarted = new Promise<void>(resolve => { started = resolve; });
  let finishAuthorization!: () => void;
  const authorization = new Promise<void>(resolve => { finishAuthorization = resolve; });
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async () => { started(); await authorization; },
  });
  await gate.start();
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await authorizationStarted;
  await gate.abortPending();
  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r1', errorReason: 'Aborted' },
  ]);
  finishAuthorization();
  await flush();
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  lease.release();

  cdp.emit('Fetch.requestPaused', pausedRequest('r2', 'https://example.test/after'));
  await flush();
  assert.deepEqual(cdp.calls('Fetch.continueRequest').map(call => call.params), [{ requestId: 'r2' }]);
  assert.equal(gate.takeVisitSource('https://example.test/after'), 'other');
  await gate.stop();
});

test('stop releases paused requests and disables Fetch', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  let started!: () => void;
  const authorizationStarted = new Promise<void>(resolve => { started = resolve; });
  let finishAuthorization!: () => void;
  const authorization = new Promise<void>(resolve => { finishAuthorization = resolve; });
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async () => { started(); await authorization; },
  });
  await gate.start();
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await authorizationStarted;
  await gate.stop();
  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r1', errorReason: 'Aborted' },
  ]);
  assert.equal(cdp.calls('Fetch.disable').length, 1);
  finishAuthorization();
  await flush();
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  cdp.emit('Fetch.requestPaused', pausedRequest('r2', 'https://example.test/late'));
  await flush();
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  lease.release();
});

test('aborting the operation lease releases its paused request', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  let started!: () => void;
  const authorizationStarted = new Promise<void>(resolve => { started = resolve; });
  let finishAuthorization!: () => void;
  const authorization = new Promise<void>(resolve => { finishAuthorization = resolve; });
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async () => { started(); await authorization; },
  });
  await gate.start();
  const leaseController = new AbortController();
  const lease = leases.begin('session-1', 1, 'agent', leaseController.signal);
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await authorizationStarted;
  leaseController.abort(new BrowserError('cancelled', 'lease aborted'));
  await flush();
  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r1', errorReason: 'Aborted' },
  ]);
  assert.equal(leases.current('session-1', 1), undefined);
  finishAuthorization();
  await flush();
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  lease.release();
  await gate.stop();
});

test('non-main-frame Document requests continue without authorization or visit source', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  const authorized: string[] = [];
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async (_sessionId, url) => { authorized.push(url); },
  });
  await gate.start();
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://frame.test/', { frameId: 'child' }), 'child-frame');
  await flush();
  assert.equal(authorized.length, 0, 'no authorization should be requested');
  const continued = cdp.calls('Fetch.continueRequest')[0];
  assert.deepEqual(continued?.params, { requestId: 'r1' });
  assert.equal(continued?.frame, 'child-frame');
  assert.equal(gate.takeVisitSource('https://frame.test/'), undefined);
  lease.release();
  await gate.stop();
});

test('policy-denied URLs fail before authorization', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  const authorized: string[] = [];
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => {
      if (String(url).includes('blocked')) throw new BrowserError('refused_by_policy', 'blocked policy');
      return new URL(String(url)).href;
    },
    authorize: async (_sessionId, url) => { authorized.push(url); },
  });
  await gate.start();
  const lease = leases.begin('session-1', 1, 'agent');
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/blocked'));
  await flush();
  assert.equal(authorized.length, 0, 'no authorization should be requested');
  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r1', errorReason: 'BlockedByClient' },
  ]);
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  lease.release();
  await gate.stop();
});

test('leases stack per page handle and keep sibling pages independent', () => {
  const leases = new NativeNavigationLeases();
  const first = leases.begin('session-1', 1, 'agent');
  const second = leases.begin('session-1', 1, 'other');
  const sibling = leases.begin('session-1', 2, 'agent');
  assert.equal(leases.current('session-1', 1)?.source, 'other');
  assert.equal(leases.current('session-1', 2)?.source, 'agent');
  second.release();
  assert.equal(leases.current('session-1', 1)?.source, 'agent');
  first.release();
  assert.equal(leases.current('session-1', 1), undefined);
  assert.equal(leases.current('session-1', 2)?.source, 'agent');
  sibling.release();
  assert.equal(leases.current('session-1', 2), undefined);
});

test('a lease for one page does not attribute a sibling page in the same session', async () => {
  const leases = new NativeNavigationLeases();
  const lease = leases.begin('session-1', 1, 'agent');
  const authorized: string[] = [];

  const siblingCdp = new FakeCdp();
  const siblingGate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 2,
    cdp: siblingCdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async (_sessionId, url) => { authorized.push(url); },
  });
  await siblingGate.start();
  siblingCdp.emit('Fetch.requestPaused', pausedRequest('s1', 'https://example.test/sibling'));
  await flush();
  assert.equal(authorized.length, 0, 'no authorization should be requested');
  assert.deepEqual(siblingCdp.calls('Fetch.continueRequest').map(call => call.params), [{ requestId: 's1' }]);
  assert.equal(siblingGate.takeVisitSource('https://example.test/sibling'), 'other');
  await siblingGate.stop();

  const agentCdp = new FakeCdp();
  const agentGate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp: agentCdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async (_sessionId, url) => { authorized.push(url); },
  });
  await agentGate.start();
  agentCdp.emit('Fetch.requestPaused', pausedRequest('a1', 'https://example.test/agent'));
  await flush();
  assert.deepEqual(authorized, ['https://example.test/agent']);
  assert.equal(agentGate.takeVisitSource('https://example.test/agent'), 'agent');
  lease.release();
  await agentGate.stop();
});

test('stop during startup serializes after Fetch.enable and releases the paused request', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  let releaseEnable!: () => void;
  const enable = new Promise<void>(resolve => { releaseEnable = resolve; });
  const originalCommand = cdp.command.bind(cdp);
  cdp.command = async (method, params = {}, frame) => {
    if (method === 'Fetch.enable') {
      cdp.commands.push({ method, params, frame });
      await enable;
      return {};
    }
    return originalCommand(method, params, frame);
  };
  let started!: () => void;
  const authorizationStarted = new Promise<void>(resolve => { started = resolve; });
  let finishAuthorization!: () => void;
  const authorization = new Promise<void>(resolve => { finishAuthorization = resolve; });
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async () => { started(); await authorization; },
  });
  const lease = leases.begin('session-1', 1, 'agent');
  const start = gate.start();
  await until(() => cdp.calls('Fetch.enable').length === 1);
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await authorizationStarted;
  const stop = gate.stop();
  releaseEnable();
  await start;
  await stop;
  finishAuthorization();
  await flush();

  assert.deepEqual(cdp.commands.map(call => call.method), [
    'Page.getFrameTree',
    'Fetch.enable',
    'Fetch.failRequest',
    'Fetch.disable',
  ]);
  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r1', errorReason: 'Aborted' },
  ]);
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  assert.equal(cdp.listenerCount, 0);
  lease.release();
});

test('startup failure releases paused requests and disables Fetch', async () => {
  const cdp = new FakeCdp();
  const leases = new NativeNavigationLeases();
  let rejectEnable!: (error: Error) => void;
  const enable = new Promise<never>((_resolve, reject) => { rejectEnable = reject; });
  const originalCommand = cdp.command.bind(cdp);
  cdp.command = async (method, params = {}, frame) => {
    if (method === 'Fetch.enable') {
      cdp.commands.push({ method, params, frame });
      await enable;
      return {};
    }
    return originalCommand(method, params, frame);
  };
  let started!: () => void;
  const authorizationStarted = new Promise<void>(resolve => { started = resolve; });
  let finishAuthorization!: () => void;
  const authorization = new Promise<void>(resolve => { finishAuthorization = resolve; });
  const gate = new NativeNavigationGate({
    sessionId: 'session-1',
    pageHandle: 1,
    cdp,
    leases,
    assertNavigation: url => new URL(String(url)).href,
    authorize: async () => { started(); await authorization; },
  });
  const lease = leases.begin('session-1', 1, 'agent');
  const start = gate.start();
  await until(() => cdp.calls('Fetch.enable').length === 1);
  cdp.emit('Fetch.requestPaused', pausedRequest('r1', 'https://example.test/start'));
  await authorizationStarted;
  rejectEnable(new Error('synthetic enable failure'));
  await assert.rejects(start, /synthetic enable failure/);
  finishAuthorization();
  await flush();

  assert.deepEqual(cdp.calls('Fetch.failRequest').map(call => call.params), [
    { requestId: 'r1', errorReason: 'Aborted' },
  ]);
  assert.equal(cdp.calls('Fetch.disable').length, 1);
  assert.deepEqual(cdp.calls('Fetch.continueRequest'), []);
  assert.equal(cdp.listenerCount, 0);
  lease.release();
});
