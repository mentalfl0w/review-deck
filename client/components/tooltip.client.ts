/**
 * Pure tooltip geometry and visibility logic, kept free of React and
 * react-native imports so it can be unit-tested deterministically under plain
 * Node (see tests/tooltip-jitter.test.ts).
 */

/** Hover/focus-out close grace period: transient pointer/focus hand-offs —
 * e.g. the overlay Modal activating or a host focus trap registering — must
 * never kill a tooltip the instant it opens. */
export const tooltipCloseDelayMs = 100;

/** A trigger rectangle measured in window/viewport coordinates. */
export type WindowFrame = { x: number; y: number; width: number; height: number };

/** Snaps a measured frame to whole pixels. Sub-pixel measurement noise
 * (fractional scroll positions, fractional flex layout, host zoom) therefore
 * never passes the update guard, so a stationary trigger never re-renders. */
export function snapWindowFrame(frame: WindowFrame): WindowFrame {
  return {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.round(frame.width),
    height: Math.round(frame.height),
  };
}

/** Exact equality on snapped frames; the "did the trigger move?" guard. */
export function windowFrameEquals(a: WindowFrame, b: WindowFrame): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Deterministic placement of the bubble relative to the trigger: above the
 * trigger by default, below as fallback when there is not enough room above,
 * clamped into the viewport when neither side fits. Horizontally centered on
 * the trigger, clamped at the viewport edges. Pure function of the measured
 * inputs — identical inputs always produce identical output. */
export function computeTooltipPosition(
  frame: WindowFrame,
  viewport: { width: number; height: number },
  bubbleSize: { width: number; height: number },
  gap = 5,
  margin = 6,
): { left: number; top: number } {
  const left = Math.max(
    margin,
    Math.min(
      frame.x + (frame.width - bubbleSize.width) / 2,
      Math.max(margin, viewport.width - bubbleSize.width - margin),
    ),
  );
  const above = frame.y - bubbleSize.height - gap;
  const below = frame.y + frame.height + gap;
  const top =
    above >= margin
      ? above
      : below + bubbleSize.height <= viewport.height - margin
        ? below
        : Math.max(margin, Math.min(below, viewport.height - bubbleSize.height - margin));
  return { left, top };
}

/** Timer host so the state machine can be driven deterministically under
 * test (injected fake timers) instead of real setTimeout. */
export type TooltipTimerHost = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const defaultTooltipTimers: TooltipTimerHost = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Deterministic delayed-close state machine for one tooltip trigger.
 * Pointer hover and keyboard focus are tracked independently; the tooltip
 * stays visible while either source is active, so losing one source never
 * closes while the other remains. A close is only committed once the last
 * source has been gone for the grace period (`delayMs`): every open cancels
 * the pending close, the delayed close re-checks both sources at fire time,
 * and a blur that is an overlay focus-trap hand-off (`focusOut(true)`) is
 * ignored entirely — transient Modal activation/focus/measure churn
 * therefore cannot toggle visibility repeatedly. `onClose` runs exactly
 * once, when the tooltip should hide. */
export interface TooltipVisibilityMachine {
  /** True while the overlay should stay visible: a source is active or a
   * close is still inside the grace period. */
  visible: () => boolean;
  /** True while at least one source still holds the tooltip open. */
  isActive: () => boolean;
  hoverIn: () => void;
  hoverOut: () => void;
  focusIn: () => void;
  /** Reports a blur. `overlayHandoff` = the focus moved into this
   * trigger's own overlay Modal (its focus trap) — that transient
   * hand-off is not a real source loss and is ignored. */
  focusOut: (overlayHandoff: boolean) => void;
  /** Explicit dismissal (Escape, Android first tap): cancels any pending
   * close and drops both sources. */
  dismiss: () => void;
  /** Cancels a pending close without touching the sources (unmount). */
  dispose: () => void;
}

export function createTooltipVisibilityMachine(
  onClose: () => void,
  delayMs: number = tooltipCloseDelayMs,
  timers?: TooltipTimerHost,
): TooltipVisibilityMachine {
  const host = timers ?? defaultTooltipTimers;
  let hoverActive = false;
  let focusActive = false;
  let closePending = false;
  let closeTimer: unknown = undefined;
  const cancelClose = () => {
    if (closeTimer !== undefined) {
      host.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    closePending = false;
  };
  const scheduleCloseIfIdle = () => {
    if (hoverActive || focusActive || closePending) return;
    closePending = true;
    closeTimer = host.setTimeout(() => {
      closeTimer = undefined;
      // Re-check at fire time: a source that returned during the grace
      // period must not be closed (open events cancel the timer, so this
      // is belt-and-braces).
      if (hoverActive || focusActive) return;
      closePending = false;
      onClose();
    }, delayMs);
  };
  return {
    /** True while the overlay should stay visible: a source is active or a
     * close is still inside the grace period. */
    visible: () => hoverActive || focusActive || closePending,
    /** True while at least one source still holds the tooltip open. */
    isActive: () => hoverActive || focusActive,
    hoverIn: () => {
      cancelClose();
      hoverActive = true;
    },
    hoverOut: () => {
      hoverActive = false;
      scheduleCloseIfIdle();
    },
    focusIn: () => {
      cancelClose();
      focusActive = true;
    },
    /** Reports a blur. `overlayHandoff` = the focus moved into this
     * trigger's own overlay Modal (its focus trap) — that transient
     * hand-off is not a real source loss and is ignored. */
    focusOut: (overlayHandoff: boolean) => {
      if (overlayHandoff) return;
      focusActive = false;
      scheduleCloseIfIdle();
    },
    /** Explicit dismissal (Escape, Android first tap): cancels any pending
     * close and drops both sources. */
    dismiss: () => {
      cancelClose();
      hoverActive = false;
      focusActive = false;
    },
    /** Cancels a pending close without touching the sources (unmount). */
    dispose: cancelClose,
  };
}
