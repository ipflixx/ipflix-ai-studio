import { useEffect } from 'react';

interface UseHybridNavigationOptions {
  /** Whether full Android TV remote directional navigation is forced on */
  tvRemoteMode: boolean;
  /** Disable spatial arrow capture while VideoPlayer owns remote keys */
  disabled?: boolean;
  /** Called on Escape / Android TV Back / Backspace (outside text inputs) */
  onBack?: () => void;
}

type Direction = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

function isVisibleFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 4 && rect.height > 4;
}

function getActiveFocusRoot(): Document | HTMLElement {
  const scopes = document.querySelectorAll<HTMLElement>('[data-focus-scope="active"]');
  if (scopes.length > 0) {
    return scopes[scopes.length - 1];
  }
  return document;
}

function findNextSpatialTarget(current: HTMLElement, dir: Direction): HTMLElement | null {
  const root = getActiveFocusRoot();
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-focusable="true"], nav button, header button, header select, main button, [role="button"][tabindex="0"]'
    )
  ).filter((el) => el !== current && isVisibleFocusable(el));

  if (candidates.length === 0) return null;

  const from = current.getBoundingClientRect();
  const fromCx = from.left + from.width / 2;
  const fromCy = from.top + from.height / 2;

  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - fromCx;
    const dy = cy - fromCy;

    let primary = 0;
    let orthogonal = 0;

    if (dir === 'ArrowRight') {
      if (dx <= 6) continue;
      primary = dx;
      orthogonal = Math.abs(dy);
      // Prefer staying within the same horizontal rail/row when moving left/right
      if (orthogonal > Math.max(from.height, r.height) * 0.85) {
        orthogonal *= 3.2;
      }
    } else if (dir === 'ArrowLeft') {
      if (dx >= -6) continue;
      primary = -dx;
      orthogonal = Math.abs(dy);
      if (orthogonal > Math.max(from.height, r.height) * 0.85) {
        orthogonal *= 3.2;
      }
    } else if (dir === 'ArrowDown') {
      if (dy <= 6) continue;
      primary = dy;
      orthogonal = Math.abs(dx);
    } else {
      if (dy >= -6) continue;
      primary = -dy;
      orthogonal = Math.abs(dx);
    }

    const score = primary + orthogonal * 2.1;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

/**
 * Provides hybrid Desktop keyboard + Android TV D-Pad directional navigation
 * and consistent Back key handling across views, modals, and horizontal rails.
 */
export function useHybridNavigation({
  tvRemoteMode,
  disabled = false,
  onBack,
}: UseHybridNavigationOptions) {
  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const activeEl = document.activeElement as HTMLElement | null;

      // Handle Back key (Escape, Android TV GoBack / BrowserBack, or Backspace outside form fields)
      const isBackKey =
        e.key === 'Escape' ||
        e.key === 'BrowserBack' ||
        e.key === 'GoBack' ||
        (e.key === 'Backspace' && !isEditableElement(activeEl));

      if (isBackKey) {
        if (onBack) {
          e.preventDefault();
          onBack();
        }
        return;
      }

      // Spatial D-pad / Arrow navigation
      if (
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowRight'
      ) {
        return;
      }

      // Allow D-pad Up/Down to exit a closed Home search input cleanly on Android TV
      const isClosedSearchInput = Boolean(
        activeEl &&
          activeEl.getAttribute('data-home-search-input') === 'true' &&
          activeEl.getAttribute('aria-expanded') !== 'true' &&
          (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      );

      if (isEditableElement(activeEl) && !isClosedSearchInput) return;

      const focusRoot = getActiveFocusRoot();
      const insideActiveScope =
        focusRoot !== document && activeEl ? focusRoot.contains(activeEl) : false;

      const isOnFocusableCardOrNav = Boolean(
        activeEl &&
          (activeEl.dataset.focusable === 'true' ||
            activeEl.closest('[data-focusable="true"]') ||
            activeEl.closest('header') ||
            insideActiveScope)
      );

      // Enable arrow spatial focus when TV Remote Mode is on OR focus is already on a focusable element / active overlay scope
      if (!tvRemoteMode && !isOnFocusableCardOrNav && focusRoot === document) return;

      const anchor =
        activeEl &&
        activeEl !== document.body &&
        (focusRoot === document || focusRoot.contains(activeEl))
          ? activeEl
          : focusRoot.querySelector<HTMLElement>('[data-focusable="true"]');

      if (!anchor) return;

      // If focus was outside an active overlay scope, move into the first focusable item in scope
      if (focusRoot !== document && (!activeEl || !focusRoot.contains(activeEl))) {
        e.preventDefault();
        anchor.focus({ preventScroll: true });
        anchor.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        return;
      }

      const target = findNextSpatialTarget(anchor, e.key);
      if (target) {
        e.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tvRemoteMode, disabled, onBack]);
}
