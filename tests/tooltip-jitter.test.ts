/**
 * Deterministic jitter regression tests for the tooltip layer.
 *
 * Runs under plain Node (no React, no react-native): only the pure logic in
 * client/components/tooltip.client.ts is exercised, with injected fake
 * timers so every assertion is deterministic.
 *
 * Run: npx tsc --outDir /tmp/tj-out --module commonjs --target ES2020
 *   --moduleResolution node --esModuleInterop --skipLibCheck --types node
 *   --lib ES2020 client/components/tooltip.client.ts tests/tooltip-jitter.test.ts
 *   && node /tmp/tj-out/tests/tooltip-jitter.test.js
 */
import assert from "node:assert/strict";
import {
  computeTooltipPosition,
  createTooltipVisibilityMachine,
  snapWindowFrame,
  windowFrameEquals,
  type TooltipTimerHost,
  type TooltipVisibilityMachine,
} from "../client/components/tooltip.client";

/** Fake timer host: advance() runs due timers in order, deterministically. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  return {
    host: {
      setTimeout: (callback: () => void, ms: number) => {
        const id = nextId++;
        queue.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        queue.delete(handle as number);
      },
    } satisfies TooltipTimerHost,
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at <= now) {
          queue.delete(id);
          entry.callback();
        }
      }
    },
    pending() {
      return queue.size;
    },
  };
}

const viewport = { width: 800, height: 600 };

// ---------------------------------------------------------------------------
// 1. Measurement noise never moves a stationary trigger (jitter regression).
// ---------------------------------------------------------------------------

{
  // Sub-pixel noise from a host (fractional scroll/flex/zoom) snaps to the
  // same whole-pixel frame every time — provided it stays within one pixel
  // bucket, which is what real measurement noise around a stationary value
  // looks like (a 0.5px shift would be real movement).
  const a = snapWindowFrame({ x: 120.2, y: 40.1, width: 84.2, height: 36.6 });
  const b = snapWindowFrame({ x: 120.45, y: 39.9, width: 84.19, height: 36.61 });
  assert.equal(windowFrameEquals(a, b), true, "sub-pixel noise must not change a snapped frame");

  // ...and a sequence of noisy measurements of the same stationary trigger
  // never reports movement (this was the per-frame shake: the old exact-float
  // guard passed on fractional rects and re-set position every frame).
  const noisy: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let i = 0; i < 200; i++) {
    const jitter = (i * 7919) % 1000 / 1000; // deterministic 0..1 noise
    const frame = snapWindowFrame({ x: 300 + (jitter - 0.5) * 0.6, y: 200 + (jitter - 0.5) * 0.4, width: 80, height: 32 });
    if (noisy.length === 0 || !windowFrameEquals(noisy[noisy.length - 1], frame)) noisy.push(frame);
  }
  assert.equal(noisy.length, 1, "a stationary trigger must snap to exactly one frame across noisy measures");
  assert.deepEqual(noisy[0], { x: 300, y: 200, width: 80, height: 32 });

  // Only real movement (>= 0.5px of accumulated drift) produces an update.
  const moved = snapWindowFrame({ x: 301.4, y: 200, width: 80, height: 32 });
  assert.equal(windowFrameEquals(noisy[0], moved), false, "real movement must still update the frame");
}

// ---------------------------------------------------------------------------
// 2. Placement: above-first, below fallback, viewport clamping, determinism.
// ---------------------------------------------------------------------------

{
  const frame = { x: 100, y: 300, width: 80, height: 32 };
  const bubble = { width: 120, height: 40 };
  // Above the trigger by default (y = 300 - 40 - 5 = 255), horizontally
  // centered (x = 100 + (80-120)/2 = 80).
  assert.deepEqual(computeTooltipPosition(frame, viewport, bubble), { left: 80, top: 255 });

  // Not enough room above -> below the trigger (y = 300 + 32 + 5 = 337).
  const nearTop = { x: 100, y: 20, width: 80, height: 32 };
  assert.deepEqual(computeTooltipPosition(nearTop, viewport, bubble), { left: 80, top: 57 });

  // Neither side fits -> clamped inside the viewport with the margin.
  const tinyViewport = { width: 200, height: 100 };
  const hugeBubble = { width: 250, height: 200 };
  assert.deepEqual(computeTooltipPosition({ x: 0, y: 10, width: 20, height: 20 }, tinyViewport, hugeBubble), { left: 6, top: 6 });

  // Horizontal clamping at both edges.
  assert.equal(computeTooltipPosition({ x: 0, y: 300, width: 10, height: 10 }, viewport, bubble).left, 6);
  assert.equal(computeTooltipPosition({ x: 790, y: 300, width: 10, height: 10 }, viewport, bubble).left, 800 - 120 - 6);

  // Determinism: identical inputs always produce identical output.
  assert.deepEqual(computeTooltipPosition(frame, viewport, bubble), computeTooltipPosition(frame, viewport, bubble));
}

// ---------------------------------------------------------------------------
// 3. Visibility machine: focus/hover churn never reopens or oscillates.
// ---------------------------------------------------------------------------

function machineScenario(): { machine: TooltipVisibilityMachine; timers: ReturnType<typeof fakeTimers>; closes: { count: number } } {
  const timers = fakeTimers();
  const closes = { count: 0 };
  const machine = createTooltipVisibilityMachine(() => { closes.count += 1; }, 100, timers.host);
  return { machine, timers, closes };
}

{
  // Stationary hover + measurement-noise focus churn: the tooltip stays
  // visible and closes exactly once when the pointer leaves.
  const { machine, timers, closes } = machineScenario();
  assert.equal(machine.visible(), false, "closed initially");
  machine.hoverIn();
  assert.equal(machine.visible(), true, "open on hover");
  for (let i = 0; i < 50; i++) {
    // Overlay focus-trap hand-offs (blur whose focus moved into the overlay)
    // and focus restores must not toggle the machine.
    machine.focusIn();
    machine.focusOut(true);
  }
  machine.focusOut(false); // focus lost for real, hover still holds
  timers.advance(1000);
  assert.equal(machine.visible(), true, "hover alone keeps the tooltip open through focus churn");
  assert.equal(closes.count, 0);
  machine.hoverOut();
  assert.equal(machine.visible(), true, "still visible inside the close grace period");
  timers.advance(99);
  assert.equal(closes.count, 0, "close only after the grace period");
  timers.advance(1);
  assert.equal(closes.count, 1, "closes exactly once");
  assert.equal(machine.visible(), false);
  timers.advance(5000);
  assert.equal(closes.count, 1, "never closes again");
}

{
  // Adjacent-trigger transition: moving to the next trigger during the grace
  // period cancels the close (no oscillation); leaving for good closes once.
  const { machine, timers, closes } = machineScenario();
  machine.hoverIn();
  machine.hoverOut();
  timers.advance(50);
  machine.hoverIn(); // pointer reached the adjacent trigger
  timers.advance(500);
  assert.equal(closes.count, 0, "adjacent transition must cancel the pending close");
  assert.equal(machine.visible(), true);
  machine.hoverOut();
  timers.advance(100);
  assert.equal(closes.count, 1, "closes once after the final hover-out");
}

{
  // Rapid oscillation between two triggers: any number of hoverIn/hoverOut
  // cycles inside the grace period commits at most one close, at the end.
  const { machine, timers, closes } = machineScenario();
  for (let i = 0; i < 10; i++) {
    machine.hoverIn();
    machine.hoverOut();
    timers.advance(30); // always inside the 100ms grace
  }
  machine.hoverIn();
  machine.hoverOut();
  timers.advance(100);
  assert.equal(closes.count, 1, "oscillation commits exactly one close");
  timers.advance(1000);
  assert.equal(closes.count, 1);
}

{
  // Flicker regression: repeated hover open/close cycles with overlay focus
  // hand-offs interleaved (what the host's modal/focus management used to
  // produce) must keep the tooltip stable while the pointer holds, and
  // commit exactly one close when the pointer finally leaves.
  const { machine, timers, closes } = machineScenario();
  for (let cycle = 0; cycle < 10; cycle++) {
    machine.hoverIn();
    // Host churn while open: focus pulled into the overlay, then restored.
    machine.focusIn();
    machine.focusOut(true);
    machine.focusOut(false); // real focus loss, hover still holds
    timers.advance(250); // well past the grace period
    assert.equal(machine.visible(), true, `hover holds through host churn (cycle ${cycle})`);
    assert.equal(closes.count, 0, `no close while hovering (cycle ${cycle})`);
    machine.hoverOut();
    timers.advance(20); // inside the grace period
    assert.equal(machine.visible(), true, "close grace keeps it visible");
  }
  timers.advance(100);
  assert.equal(closes.count, 1, "flicker cycle commits exactly one close at the end");
  timers.advance(5000);
  assert.equal(closes.count, 1, "never closes again after the final leave");
}

console.log("tooltip-jitter: all assertions passed");
