import { useEffect, useRef, useState } from 'react';

/**
 * Infinite scroll. An IntersectionObserver rather than a scroll handler: it
 * does not fire on every pixel. The callback is kept in a ref so a new
 * closure each render does not tear the observer down and rebuild it.
 */
export function useSentinel(enabled, onHit) {
  const ref = useRef(null);
  const cb = useRef(onHit);
  cb.current = onHit;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) cb.current();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);

  return ref;
}

export function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Width of an element, tracked across resizes. Height is ignored on purpose. */
export function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'textarea:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Dialog focus handling: remember where focus was, move it into the dialog,
 * keep Tab inside it, and hand it back on close. `aria-modal` tells a screen
 * reader to ignore the page behind; it does nothing about the Tab key.
 */
export function useFocusTrap(open) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement;
    const root = ref.current;
    const first = root?.querySelector('[data-autofocus]') || root?.querySelector('.icon-btn');
    first?.focus();

    const onKey = (e) => {
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const a = items[0];
      const z = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || !root.contains(document.activeElement))) {
        e.preventDefault(); z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault(); a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus();
    };
  }, [open]);

  return ref;
}
