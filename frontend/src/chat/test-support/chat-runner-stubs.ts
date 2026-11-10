// Tests execute real `chat.ts` functions inside a bare VM context by extracting
// their declarations with the TypeScript AST. Those functions close over
// module-level collaborators that the VM does not have, so every harness that
// extracts composer/side-surface code must declare the same inert stand-ins
// first. Keeping them in one place stops each new harness from rediscovering
// the same ReferenceError when `chat.ts` grows another module-level symbol.

/** Inert stand-ins for `chat.ts` module state referenced by extracted functions. */
export const chatRunnerStubs = `
var sideFriendIntentApi = { setHidden() {}, setValue() {}, setDisabled() {} };
var sideFriendContexts = new Map();
var friendComposeContext = { intent: 'request' };
var updateFriendComposeControls = function updateFriendComposeControls() {};
var sideFriendSending = false;
var friendSendInFlight = false;
var submitDirectFriendMessage = async function submitDirectFriendMessage() { return false };
// The real function loads through the catalog cache; fixtures usually hand over
// a plain Map, so accept both shapes instead of failing the refresh.
var buildMainModelItems = async function buildMainModelItems(source) {
  if (typeof mainModelCatalogCache === 'undefined') return [];
  if (typeof mainModelCatalogCache.load === 'function') return mainModelCatalogCache.load(source);
  return mainModelCatalogCache.get(source) || [];
};
var composerReferenceEntries = function composerReferenceEntries() { return []; };
// Round-4 side-surface self-heal and refusal net import these from stream-store
// and send-refusal; extracted composer code touches them on activate and on a
// refused submit, so the inert stand-ins keep the VM context complete.
var reviveSessionStream = function reviveSessionStream() { return false; };
var isTurnInProgressRefusal = function isTurnInProgressRefusal() { return false; };
`

/** Same stand-ins as an object spread for harnesses that build a VM context literally. */
export const chatRunnerStubContext = () => ({
  sideFriendIntentApi: { setHidden() {}, setValue() {}, setDisabled() {} },
  sideFriendContexts: new Map<string, { intent: string }>(),
  friendComposeContext: { intent: 'request' },
  updateFriendComposeControls: () => {},
  sideFriendSending: false,
  friendSendInFlight: false,
  submitDirectFriendMessage: async () => false,
  buildMainModelItems: async (source: string) => {
    const cache = (globalThis as any).mainModelCatalogCache
    if (typeof cache?.load === 'function') return cache.load(source)
    return cache?.get(source) || []
  },
  composerReferenceEntries: () => [],
  reviveSessionStream: () => false,
  isTurnInProgressRefusal: () => false,
})
