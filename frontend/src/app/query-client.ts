import { QueryClient } from '@tanstack/react-query'

/**
 * The one QueryClient for the whole renderer.
 *
 * Each React island mounts with its own `createRoot` (transcript, composer
 * model/permission selects, the plus menu, the @/slash menu, previews) and there
 * is no shared Provider above them. A module-level singleton is what lets those
 * islands share one cache: the @-menu's plugin group and the plugins page both
 * read `plugins:list`, and a device rename must invalidate the picker from
 * wherever the settings island lives. Passing a client through props instead
 * would not reach islands that do not share a component tree.
 *
 * Two defaults are tightened deliberately, both learned from a stalled cloud
 * channel that hung the @-menu:
 *
 * - `retry: false`. react-query defaults to three retries with backoff. These
 *   queries sit behind host channels that serialize onto a single queue, so
 *   retrying a call that is already stuck multiplies the queue depth and turns a
 *   slow source into a dead one. A failed group degrades on its own instead.
 * - `refetchOnWindowFocus: false`. This is a resident desktop window, not a web
 *   page: regaining focus says nothing about whether plugins, devices or the
 *   conversation list changed, and refetching on every alt-tab would hammer the
 *   same slow channels. Freshness is driven by staleTime and explicit
 *   invalidation instead.
 *
 * `refetchOnReconnect` stays on the default: a reconnect is a real signal that
 * an offline source may now answer, and these queries are short and bounded.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
})
