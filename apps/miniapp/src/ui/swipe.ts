import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

export type SwipeSide = 'agree' | 'disagree';

const THRESHOLD_PX = 72;

/**
 * Horizontal drag on a card: right is agree, left is disagree. Vertical movement is left to the
 * page scroll. With reduced motion the card doesn't follow the finger, but the gesture still counts.
 */
export function useSwipe(onSwipe: (side: SwipeSide) => void, enabled: boolean) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  const bind = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || event.button !== 0) return;
      start.current = { x: event.clientX, y: event.clientY };
      const target = event.currentTarget;
      if (typeof target.setPointerCapture === 'function') {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // The pointer can already be gone in jsdom and on a cancelled touch.
        }
      }
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (!start.current) return;
      const dx = event.clientX - start.current.x;
      const dy = event.clientY - start.current.y;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 16) {
        start.current = null;
        setOffset(0);
        return;
      }
      setOffset(dx);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (!start.current) return;
      const dx = event.clientX - start.current.x;
      start.current = null;
      setOffset(0);
      if (!enabled) return;
      if (dx > THRESHOLD_PX) onSwipeRef.current('agree');
      else if (dx < -THRESHOLD_PX) onSwipeRef.current('disagree');
    },
    onPointerCancel() {
      start.current = null;
      setOffset(0);
    },
  };

  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style: CSSProperties | undefined =
    offset !== 0 && !reduceMotion
      ? { transform: `translateX(${offset}px) rotate(${offset / 28}deg)` }
      : undefined;
  const direction = offset > 36 ? 'agree' : offset < -36 ? 'disagree' : undefined;
  return { bind, style, direction };
}
