// React glue for command handlers.
//
// A component that owns an action calls `useCommandHandler('toggleSidebar', fn)`
// and the keymap runtime will dispatch to it while the component is mounted.
// `isActive` is the guard used instead of declarative `when` clauses:
// the handler stays registered but declines while its surface is not on screen.
// Returning false from the handler means "not consumed", so dispatch falls
// through to the next registration.

import { useEffect, useRef } from 'react';
import {
  registerCommandHandler,
  type CommandHandlerOptions,
  type DispatchSource,
} from './dispatcher';
import { refreshKeybindingRuntime } from './runtime';

/**
 * Register `handler` for `commandId` for the lifetime of this component.
 *
 * The handler is held in a ref so an inline closure does not re-register on
 * every render; only a change of `commandId`, `enabled` or `isActive` identity
 * tears the registration down. Registration changes notify the runtime so the
 * listener set is rebuilt (a command that just gained its first handler must
 * start receiving keys immediately).
 */
export function useCommandHandler(
  commandId: string,
  handler: (source: DispatchSource, event?: KeyboardEvent) => boolean | void,
  options: CommandHandlerOptions & { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const isActiveRef = useRef(options.isActive);
  isActiveRef.current = options.isActive;
  const priority = options.priority ?? 'normal';

  useEffect(() => {
    if (!enabled) return;
    const unregister = registerCommandHandler(
      commandId,
      (source, event) => handlerRef.current(source, event),
      {
        priority,
        ...(isActiveRef.current == null ? {} : { isActive: source => isActiveRef.current!(source) }),
      },
    );
    refreshKeybindingRuntime();
    return () => {
      unregister();
      refreshKeybindingRuntime();
    };
  }, [commandId, enabled, priority]);
}

/** Register a handler that lives outside React (a plain module). Same contract,
 * no hook; the caller owns disposal. */
export function bindCommandHandler(
  commandId: string,
  handler: (source: DispatchSource, event?: KeyboardEvent) => boolean | void,
  options: CommandHandlerOptions = {},
): () => void {
  const unregister = registerCommandHandler(commandId, handler, options);
  refreshKeybindingRuntime();
  return () => {
    unregister();
    refreshKeybindingRuntime();
  };
}
