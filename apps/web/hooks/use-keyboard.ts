import { useEffect, useCallback } from "react";

interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  const handler = useCallback(
    (e: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const ctrlMatch = shortcut.ctrl ? e.ctrlKey || e.metaKey : true;
        const metaMatch = shortcut.meta ? e.metaKey : true;
        const shiftMatch = shortcut.shift ? e.shiftKey : true;
        const altMatch = shortcut.alt ? e.altKey : true;
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();

        if (keyMatch && ctrlMatch && metaMatch && shiftMatch && altMatch) {
          // Don't intercept when user is typing in an input
          const target = e.target as HTMLElement;
          if (
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable
          ) {
            continue;
          }
          e.preventDefault();
          shortcut.action();
        }
      }
    },
    [shortcuts],
  );

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}

/**
 * Trap focus within a container element (for modals/dialogs).
 */
export function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const focusable = container.querySelectorAll(focusableSelector);
      if (focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [containerRef]);
}

/**
 * Announce content to screen readers via a live region.
 */
export function announceToScreenReader(message: string, priority?: "polite" | "assertive") {
  const el = document.getElementById("sr-announcer");
  if (!el) return;
  el.setAttribute("aria-live", priority ?? "polite");
  el.textContent = "";
  requestAnimationFrame(() => {
    el.textContent = message;
  });
}
