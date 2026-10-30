// The Klaus account state the login gate reads.
//
// `klausAuth:status` is the single most boot-critical channel in the whole app, and the
// reason is a `return` statement in the frontend. `src/chat/chat.ts:11581-11600`:
//
//   let loggedIn = false; let guest = false;
//   try { const status = await klausApi.klausAuth?.status?.();
//         loggedIn = !!status?.loggedIn; guest = !loggedIn && !!status?.guest; }
//   catch (err) { console.warn('klausAuth status failed:', err) }
//   if (!loggedIn && !guest) { setUpgradeMenuVisible(false); showLoginScreen(); return }
//
// That `return` exits `boot()` before `init()` runs, so NOTHING downstream is wired: no
// session list, no composer, no event subscriptions. A handler that REJECTS — a thrown
// error, a missing channel, a `NOT_MIGRATED` refusal — is therefore indistinguishable from
// "this user is not signed in", and the app parks on the login screen permanently with no
// retry path. This module exists to make that impossible: it always returns an object, and
// every failure mode resolves to the guest shape rather than throwing.
//
// Ported from `klaus_auth_status` in the retired Rust shell (`main.rs`), plus
// `accounts::guest_mode_active` and `accounts::read_stored_auth` (`accounts.rs`).
// Read those sources with `git show c743c126^:apps/tauri/crates/klaus-shell/src/main.rs`
// and find the functions by name (see `main/paths.ts`). It is PURELY LOCAL — the Rust
// calls no engine method for it (confirmed: `klausAuth:status` dispatches straight to
// `klaus_auth_status()`, which reads one file), so the gate cannot be blocked by an
// engine that is still starting.
//
// THE THREE-STATE AUTH FILE. `read_stored_auth_outcome` distinguishes Missing from
// Unreadable, but `read_stored_auth` collapses both to `None`. That collapse is load-bearing
// for guest mode: a CORRUPT auth file must not lock the user out, so it reads as "no stored
// account" and the guest marker still decides. This port keeps the same collapse, and adds
// nothing that could turn an unreadable file into a rejection.
//
// VERIFIED AGAINST THE REAL PROFILE. On this machine `~/.klaus/klaus-auth.json` is absent
// and `~/.klaus/klaus-guest-mode` exists (1 byte), so the honest answer is
// `{loggedIn:false, guest:true}` — which passes the gate and lets the workbench boot without
// a cloud account, exactly as AGENTS.md describes guest mode.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { configRootFrom } from './config-root';
import type { Json } from '../ipc/contract';

/** The stored account file (`accounts.rs:auth_file()` -> `config_root/klaus-auth.json`). */
function authFilePath(configRoot: string): string {
  return join(configRoot, 'klaus-auth.json');
}

/**
 * The guest marker (`accounts.rs:301-303`).
 *
 * A file whose EXISTENCE is the flag; its contents are never read.
 */
function guestMarkerPath(configRoot: string): string {
  return join(configRoot, 'klaus-guest-mode');
}

/**
 * Whether a stored account exists and parses (`accounts::read_stored_auth`,
 * `accounts.rs:~283-296`).
 *
 * Missing and unreadable both answer `undefined`, deliberately: see the three-state note
 * above. Only a file that parses as JSON counts as a stored account.
 */
export function readStoredAuth(configRoot: string = configRootFrom()): Json | undefined {
  let raw: string;
  try {
    raw = readFileSync(authFilePath(configRoot), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Whether the local workbench may pass the login gate without a cloud account
 * (`accounts::guest_mode_active`, `accounts.rs:307-309`).
 *
 * A stored account ALWAYS wins over a stale guest marker: successful sign-in removes the
 * marker, but this guard also keeps a partial cleanup harmless. So both conditions must hold
 * — no stored auth AND the marker file present.
 */
export function guestModeActive(configRoot: string = configRootFrom()): boolean {
  return readStoredAuth(configRoot) === undefined && existsSync(guestMarkerPath(configRoot));
}

/**
 * `klaus_auth_status` (`main.rs:3222-3237`).
 *
 * Returns `{loggedIn:true, user}` when the auth file holds a `user` OBJECT, otherwise
 * `{loggedIn:false, guest:<marker>}`. Note the shape check: a file whose `user` is a string
 * or an array is treated as no account, matching the Rust's `Some(user) if user.is_object()`.
 *
 * This function CANNOT throw and CANNOT reject, which is the whole point — see the header.
 */
export function klausAuthStatus(configRoot: string = configRootFrom()): Json {
  const guest = (): Json => ({ loggedIn: false, guest: guestModeActive(configRoot) });

  const stored = readStoredAuth(configRoot);
  if (stored === undefined || typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return guest();
  }
  const user = (stored as Record<string, Json>).user;
  if (user !== undefined && typeof user === 'object' && user !== null && !Array.isArray(user)) {
    return { loggedIn: true, user };
  }
  return guest();
}

/**
 * Is this install signed in to a Klaus cloud account?
 *
 * Split out because several surfaces ask this narrower question than `klausAuth:status`
 * does — the mobile bridge needs to know
 * whether a relay leg is usable at all. Reading `klausAuthStatus().loggedIn` everywhere
 * would rebuild the guest check each time and invite a caller to forget that `loggedIn:false`
 * does not mean "no account context".
 */
export function isLoggedIn(configRoot: string = configRootFrom()): boolean {
  const status = klausAuthStatus(configRoot);
  return typeof status === 'object' && status !== null && (status as { loggedIn?: Json }).loggedIn === true;
}
