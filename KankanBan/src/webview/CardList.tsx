import { useEffect, useRef, type HTMLAttributes } from 'react';

export function CardList({ horizontal, ...props }: HTMLAttributes<HTMLDivElement> & { horizontal: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !horizontal) return;
    let target = element.scrollLeft, lastWheel = 0;
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > 0 || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault(); event.stopPropagation();
      const now = Date.now();
      if (now - lastWheel > 180) target = element.scrollLeft;
      lastWheel = now;
      target = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, target + event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1)));
      element.scrollTo({ left: target, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [horizontal]);
  return <div {...props} ref={ref} />;
}
