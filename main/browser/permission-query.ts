// The host's site policy is three-state — allow, deny, ask — while the
// runtime's permission check API reports only allow or deny. An undecided
// permission therefore looks denied to page scripts, and a page cannot tell
// "the host will ask" from "the host refused". The manager already owns a
// debugger session per page, so it renders its own policy into every browser
// document at document start: a permission query for an undecided name
// reports the ask state, while explicit host decisions pass the native
// result through unchanged. Nothing here changes when a request is granted or
// refused; it only aligns the observable state with the host's real policy.

export const PERMISSION_QUERY_SCRIPT_KEY = 'klaus-permission-query-policy';

/** Permission names whose undecided host state is "ask". */
export const PERMISSION_QUERY_ASK_NAMES: readonly string[] = ['persistent-storage'];

export interface PermissionQueryPolicy {
  [name: string]: { denied: string[] };
}

/**
 * Fold every explicit denial of one permission into the policy the document
 * script consults: persistent settings rows plus task-scoped decisions. An
 * origin absent from the list is undecided and must report the ask state.
 */
export function synthesizePermissionQueryPolicy(
  names: readonly string[],
  storeDenials: (permission: string) => string[],
  taskDenials: (permission: string) => string[],
): PermissionQueryPolicy {
  const policy: PermissionQueryPolicy = {};
  for (const name of names) {
    policy[name] = { denied: [...new Set([...storeDenials(name), ...taskDenials(name)])].sort() };
  }
  return policy;
}

/**
 * Main-world document-start source. The script wraps only the permission
 * query entry point, keeps the native PermissionStatus object (instanceof,
 * change events and all other descriptors stay native), and shadows the state
 * getter solely for the undecided case. The host updates an open document
 * through the hidden update seam; cached statuses are re-checked against the
 * native state and announce real transitions with a change event.
 */
export function permissionQueryShimSource(policy: PermissionQueryPolicy): string {
  return `(function () {
  var policy = ${JSON.stringify(policy)};
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return;
  var defineHidden = function (target, name, value) {
    Object.defineProperty(target, name, { value: value, configurable: true, writable: true, enumerable: false });
  };
  if (window.__klausPermissionQueryPolicy) {
    if (typeof window.__klausPermissionPolicyUpdate === 'function') window.__klausPermissionPolicyUpdate(policy);
    return;
  }
  var tracked = new Map();
  var pageOrigin = function () { try { return location.origin; } catch (error) { return 'null'; } };
  var effective = function (name, nativeState) {
    var entry = policy[name];
    if (!entry || nativeState !== 'denied') return nativeState;
    var origin = pageOrigin();
    if (!origin || origin === 'null') return nativeState;
    return entry.denied.indexOf(origin) >= 0 ? nativeState : 'prompt';
  };
  var shadow = function (status, state) {
    Object.defineProperty(status, 'state', { configurable: true, enumerable: true, get: function () { return state; } });
  };
  var nativeQuery = navigator.permissions.query.bind(navigator.permissions);
  var refresh = function (status, info) {
    nativeQuery(info.descriptor).then(function (fresh) {
      var state = effective(info.name, fresh.state);
      info.native = fresh.state;
      if (state !== info.state) {
        info.state = state;
        shadow(status, state);
        try { status.dispatchEvent(new Event('change')); } catch (error) { /* a detached status object keeps no listeners */ }
      }
    }).catch(function () { /* the document navigated away mid-refresh */ });
  };
  var query = function (descriptor) {
    return nativeQuery(descriptor).then(function (status) {
      var name = descriptor && typeof descriptor.name === 'string' ? descriptor.name : '';
      if (!name || !policy[name] || !status) return status;
      var native = status.state;
      var state = effective(name, native);
      if (state !== native) shadow(status, state);
      tracked.set(status, { descriptor: descriptor, name: name, native: native, state: state });
      return status;
    });
  };
  defineHidden(query, 'name', 'query');
  defineHidden(query, 'toString', function () { return 'function query() { [native code] }'; });
  defineHidden(window, '__klausPermissionQueryPolicy', true);
  defineHidden(window, '__klausPermissionPolicyUpdate', function (next) {
    policy = next && typeof next === 'object' ? next : {};
    tracked.forEach(function (info, status) { refresh(status, info); });
  });
  Object.defineProperty(navigator.permissions, 'query', { value: query, configurable: true, enumerable: true, writable: true });
})();`;
}

/** Expression the host evaluates in an open document after a policy change. */
export function permissionQueryUpdateExpression(policy: PermissionQueryPolicy): string {
  return `window.__klausPermissionPolicyUpdate && window.__klausPermissionPolicyUpdate(${JSON.stringify(policy)});`;
}
