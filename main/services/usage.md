# Active-source usage

`registerUsageHandlers(registry, service)` registers the existing
`usage:subscriptions` invoke. `UsageService.query()` returns
`{ok:true,snapshot:{mode,provider,fetchedAt}}`. Only the active auth mode is read.

Composition injects the active session's `authMode(sessionId)` and configured model
credential flags, the named engine request callback, and
`account.subscriptions.codexAccessToken(signal)`.
Qoder calls only the existing named `qoder/usage` facade.

Claude calls `claude/usage`: the engine uses each account's current OAuth
credential namespace and refresh lock, renews expired tokens, and retries a 401
once after renewal. The host never reads login seed tokens for quota requests.
Each account settles independently without advancing the rotation queue; even
a failed head leaves healthy tail accounts visible. Codex fetches its usage
endpoint, retaining both known quota spellings and unknown named windows.
Qoder keeps independent personal and organization credit pools. Provider usage
is independent of the Klaus account. Custom source output lists configured models
without API keys. Credentials never appear in the returned snapshot.

`SubscriptionAuthService.codexAccessToken(signal?)` is a host-only method. It uses
the existing account selection and `openai-subscription-oauth.json`, renews a token
inside its final minute using the existing OAuth endpoint, and commits through
the same owner write queue. Concurrent readers share the renewed token. Logout
epoch changes, cancelled requests, host close and a changed stored account reject
late publication. Failure preserves the previous account. The method does not
register an IPC channel or return tokens through an invoke.

Usage HTTP is bounded to 1 MiB, has a 15-second timeout and rejects redirects.
HTTPS is required except loopback fixtures. An invalid JSON body reports an error
rather than a successful empty quota. HTTP errors expose the status, not a remote
body that could echo credentials. Await `usage.close()` before closing its account
and engine dependencies. Then await the subscription owner's close, which drains
the real refresh request and write queue.
