import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PetCatalogEntry } from "../../../contracts/desktop-pet";
import {
  animationSequence,
  framePosition,
  lookFrame,
  type PetAnimation,
  type PetFrame,
} from "./animation";

/** Live view of the system's reduced-motion preference. */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduce;
}

export function PetSprite({
  pet,
  state = "idle",
  transientState,
  size = 112,
  trackPointer = false,
  lookAt = null,
  respondToHover = false,
  loop = false,
  className = "",
}: {
  pet: PetCatalogEntry;
  state?: PetAnimation;
  transientState?: PetAnimation;
  size?: number;
  trackPointer?: boolean;
  lookAt?: { x: number; y: number } | null;
  respondToHover?: boolean;
  loop?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [look, setLook] = useState<PetFrame | null>(null);
  const reduce = usePrefersReducedMotion();
  const animation = transientState ?? (respondToHover && hover ? "jumping" : state);
  useEffect(() => {
    if (!trackPointer || reduce || !["idle", "running", "waving"].includes(animation)) {
      setLook(null);
      return;
    }
    if (lookAt && ref.current) {
      const next = lookFrame(ref.current.getBoundingClientRect(), lookAt, pet.spriteVersion);
      setLook(current => current?.row === next?.row && current?.column === next?.column ? current : next);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const move = (event: PointerEvent) => {
      if (!ref.current || reduce) return;
      const next = lookFrame(
          ref.current.getBoundingClientRect(),
          { x: event.clientX, y: event.clientY },
          pet.spriteVersion,
        );
      setLook(current => current?.row === next?.row && current?.column === next?.column ? current : next);
      clearTimeout(timer);
      timer = setTimeout(() => setLook(null), 1800);
    };
    const external = (event: Event) => {
      const point = (event as CustomEvent<{ x: number; y: number }>).detail;
      move({ clientX: point.x, clientY: point.y } as PointerEvent);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pet-pointer", external);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pet-pointer", external);
    };
  }, [trackPointer, animation, pet.spriteVersion, reduce, lookAt?.x, lookAt?.y]);
  useEffect(() => {
    if (!respondToHover) return;
    const target = ref.current?.parentElement;
    if (!target) return;
    const enter = () => setHover(true), leave = () => setHover(false);
    target.addEventListener("pointerenter", enter); target.addEventListener("pointerleave", leave);
    return () => { target.removeEventListener("pointerenter", enter); target.removeEventListener("pointerleave", leave); };
  }, [respondToHover]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (look) {
      element.style.backgroundPosition = framePosition(look, pet.spriteVersion);
      return;
    }
    const sequence = animationSequence(animation, reduce, loop);
    let index = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    const advance = () => {
      element.style.backgroundPosition = framePosition(
        sequence.frames[index],
        pet.spriteVersion,
      );
      if (sequence.frames.length === 1) return;
      timer = setTimeout(() => {
        index += 1;
        if (index === sequence.frames.length) {
          if (sequence.loopStart === null) return;
          index = sequence.loopStart;
        }
        advance();
      }, sequence.frames[index].duration);
    };
    advance();
    return () => clearTimeout(timer);
  }, [animation, look, loop, pet.spriteVersion, reduce]);
  return (
    <div
      ref={ref}
      className={`pet-sprite ${className}`}
      data-pet-id={pet.id}
      data-pet-state={animation}
      aria-hidden="true"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={
        {
          width: size,
          height: (size * 208) / 192,
          backgroundImage: `url(${JSON.stringify(pet.spritesheetUrl)})`,
          backgroundSize: `800% ${pet.spriteVersion === 2 ? 1100 : 900}%`,
        } as CSSProperties
      }
    />
  );
}
