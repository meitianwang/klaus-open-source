import { useEffect, useRef, useState } from "react";
import type { PetAnimation } from "./animation";
import {
  oneShotDuration,
  pickSpontaneousAnimation,
  spontaneousDelay,
} from "./spontaneous";

const defaultSchedule = () => spontaneousDelay(Math.random);

/**
 * Schedules self-started reactions while `enabled` stays true and reports the
 * one currently playing, or null between them. The caller owns the suppression
 * policy (interaction, running tasks, reduced motion); this hook only owns the
 * random cadence and the settle-back timing. `schedule` must be a stable
 * function: a fresh arrow every render would restart the pending wait.
 */
export function useSpontaneousAnimation(
  enabled: boolean,
  schedule: () => number = defaultSchedule,
): PetAnimation | null {
  const [current, setCurrent] = useState<PetAnimation | null>(null);
  const previous = useRef<PetAnimation | null>(null);
  useEffect(() => {
    if (!enabled) {
      setCurrent(null);
      return;
    }
    let wait: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      wait = setTimeout(() => {
        const next = pickSpontaneousAnimation(Math.random, previous.current);
        previous.current = next;
        setCurrent(next);
        settle = setTimeout(() => {
          setCurrent(null);
          arm();
        }, oneShotDuration(next));
      }, schedule());
    };
    arm();
    return () => {
      clearTimeout(wait);
      clearTimeout(settle);
    };
  }, [enabled, schedule]);
  return current;
}
