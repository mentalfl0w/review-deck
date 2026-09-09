/**
 * Narrow web-only DOM bridge for the client UI tree.
 *
 * The v0.8 client build compiles without DOM lib declarations, so no module
 * outside this one may name browser globals (`window`, `document`,
 * `KeyboardEvent`, `Element`, `requestAnimationFrame`, ...). Every adapter
 * here is a no-op unless running on the web platform (`Platform.OS ===
 * "web"`), which keeps native bundles free of DOM access while web behavior
 * stays exactly as before the split.
 *
 * The real browser global object crosses this module's boundary exactly
 * once, statically typed as the minimal structural surfaces below (every
 * member optional). Everything past the boundary is plain access through
 * those surfaces, plus runtime shape checks where a value is trusted to be
 * a DOM node (the tooltip focus hand-off walk). This module therefore
 * typechecks both with and without DOM lib declarations.
 */
import { Platform } from "react-native";

/** The element surface the tooltip focus hand-off walk needs. */
interface WebElement {
  readonly nodeType: number;
  closest(selector: string): WebElement | null;
  contains(other: WebElement): boolean;
  readonly parentElement: WebElement | null;
}

/** The document surface used for key handling and focus introspection. */
interface WebDocument {
  readonly activeElement: WebElement | null;
  querySelector(selector: string): WebElement | null;
  addEventListener(type: string, listener: (event: { key: string }) => void): void;
  removeEventListener(type: string, listener: (event: { key: string }) => void): void;
}

/** The window surface used for event subscription and viewport size. */
interface WebWindow {
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/** Structural view of the browser globals this module touches. */
interface WebGlobal {
  window?: WebWindow;
  document?: WebDocument;
  navigator?: { readonly language?: string };
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

// Boundary: the browser global object under the minimal typed surfaces above.
// The double cast is deliberate — the real object is far richer than these
// interfaces and may be absent entirely (native runtime, no-DOM compile).
const webGlobal = globalThis as unknown as WebGlobal;

const isWeb = Platform.OS === "web";

/** Shared no-op returned by off-web subscriptions and cancels. */
const noop = () => {};

/** True when the value is a genuine DOM element (nodeType 1 with the walk's
 * methods) — the structural stand-in for `instanceof Element`, which also
 * keeps working across frames. */
function isElementNode(value: unknown): value is WebElement {
  if (typeof value !== "object" || value === null) return false;
  if (!("nodeType" in value) || !("closest" in value) || !("contains" in value) || !("parentElement" in value)) return false;
  return value.nodeType === 1 && typeof value.closest === "function" && typeof value.contains === "function"
    && (value.parentElement === null || typeof value.parentElement === "object");
}

/** Subscribes to a window event on web; returns the unsubscribe function
 * (a no-op on native). The scroll subscription is capture-phase so nested
 * ScrollViews are heard. */
export function subscribeWindowEvent(
  type: "scroll" | "resize",
  listener: () => void,
  capture?: boolean,
): () => void {
  const win = webGlobal.window;
  if (!isWeb || !win) return noop;
  win.addEventListener(type, listener, capture);
  return () => win.removeEventListener(type, listener, capture);
}

/** The window inner size on web; null on native or when the window is gone. */
export function getWindowViewport(): { width: number; height: number } | null {
  const win = webGlobal.window;
  if (!isWeb || !win) return null;
  return { width: win.innerWidth, height: win.innerHeight };
}

/** Subscribes to document keydown on web, delivering each event's key;
 * returns the unsubscribe function (a no-op on native). */
export function subscribeDocumentKeyDown(handler: (key: string) => void): () => void {
  const doc = webGlobal.document;
  if (!isWeb || !doc) return noop;
  const listener = (event: { key: string }) => handler(event.key);
  doc.addEventListener("keydown", listener);
  return () => doc.removeEventListener("keydown", listener);
}

/** Runs a callback on the next animation frame on web; returns a cancel
 * function (a no-op on native; cancelling an already-fired frame is safe). */
export function scheduleAnimationFrame(callback: () => void): () => void {
  const raf = webGlobal.requestAnimationFrame;
  const caf = webGlobal.cancelAnimationFrame;
  if (!isWeb || !raf || !caf) return noop;
  const handle = raf(callback);
  return () => caf(handle);
}

/** The browser UI language on web ("" on native and when unavailable). */
export function getBrowserLanguage(): string {
  if (!isWeb) return "";
  return webGlobal.navigator?.language ?? "";
}

/** True when a blur event's focus moved into the tooltip overlay with the
 * given testID. The overlay Modal's focus trap pulls focus into the overlay
 * the moment it activates, and that hand-off is not the user leaving the
 * trigger — it must not count as losing the focus source. relatedTarget is
 * authoritative; the document.activeElement fallback covers hosts that
 * deliver blur without it. react-native-web's trap focuses its wrapper
 * element (which carries no testID) when nothing inside the overlay is
 * focusable, so containment is also checked structurally: walking from the
 * testID'd content root up to the trap wrapper (never beyond into the
 * shared modal portal, which would over-match other modals). DOM-only:
 * off-web and non-element inputs always report false. */
export function focusMovedIntoOverlay(relatedTarget: unknown, overlayTestID: string): boolean {
  if (!isWeb) return false;
  const doc = webGlobal.document;
  if (!doc) return false;
  const selector = `[data-testid="${overlayTestID}"]`;
  let target = isElementNode(relatedTarget) ? relatedTarget : null;
  if (target === null) {
    const active = doc.activeElement;
    target = isElementNode(active) ? active : null;
  }
  if (target === null) return false;
  if (target.closest(selector) !== null) return true;
  const root = doc.querySelector(selector);
  if (!isElementNode(root)) return false;
  let container = root.parentElement;
  // Two levels: the ModalAnimation wrapper and the ModalFocusTrap wrapper.
  for (let depth = 0; container !== null && depth < 2; depth += 1) {
    if (container.contains(target)) return true;
    container = container.parentElement;
  }
  return false;
}
