import { Children, cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode, type RefObject } from "react";
import { Modal, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { severityColor, withAlpha, type Finding, type PanelLayout, type PanelTheme, type Severity } from "../tools.client";
import { computeTooltipPosition, createTooltipVisibilityMachine, snapWindowFrame, windowFrameEquals, type WindowFrame } from "./tooltip.client";

/** Kept exported for compatibility; the machine itself lives in
 * ./tooltip.client (pure, unit-testable). */
export { createTooltipVisibilityMachine } from "./tooltip.client";

export function SeverityBadge({ severity, label, theme, compact = false }: {
  severity: Severity;
  label: string;
  theme: PanelTheme;
  compact?: boolean;
}) {
  const color = severityColor(severity, theme);
  return (
    <View style={{ backgroundColor: withAlpha(color, 0.13), borderRadius: 999, paddingHorizontal: compact ? 6 : 7, paddingVertical: 1.5, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: compact ? 9 : 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, lineHeight: compact ? 12 : 13 }}>{label}</Text>
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Opaque hover/focus bubble painted by TooltipOverlay at viewport
 * coordinates. The background is the solid foreground color so the
 * underlying diff can never show through, and pointerEvents are disabled so
 * the bubble never intercepts hover, focus or clicks. */
const webTooltipLayerStyle: ViewStyle = {
  // react-native-web supports position: "fixed" (its own Modal root uses
  // it); the RN ViewStyle type omits it, so the web-only value is cast.
  position: "fixed" as unknown as "absolute",
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  zIndex: 2147483000,
  pointerEvents: "none",
};

function TooltipBubble({ text, theme, layout }: {
  text: string;
  theme: PanelTheme;
  layout: PanelLayout;
}) {
  const c = theme.colors;
  return (
    <View
      pointerEvents="none"
      style={{
        alignSelf: "flex-start",
        maxWidth: layout.compact ? 220 : 260,
        backgroundColor: c.foreground,
        borderWidth: 1,
        borderColor: withAlpha(c.foregroundMuted, 0.35),
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        shadowColor: c.foreground,
        shadowOpacity: 0.16,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
        elevation: 12,
      }}
    >
      <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 15, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

/** Shared top-level hover/focus tooltip overlay used by ActionButton,
 * Segmented options and HoverTooltip. It escapes every ancestor stacking
 * context and ScrollView clip (HunkCard, FileNavigator, section lists) and
 * can never be overpainted or clipped by their content.
 *
 * Platform split. On web, react-native-web's Modal is deliberately NOT used
 * for tooltips: its focus trap (which force-focuses the trap wrapper on
 * activation) and its `role="dialog"` + `aria-modal` semantics make the
 * host treat the tooltip as a real modal — the host inerts/blocks the
 * background (clicks on buttons under the tooltip stop working) and the
 * trap's focus restore churn re-opens tooltips (flicker). react-dom
 * (createPortal) is not resolvable in the host's plugin bundle, so web
 * renders an in-tree fixed layer instead: `position: fixed` with a top
 * zIndex escapes ScrollView overflow clipping (no transformed ancestor) and
 * paints above all panel content, while `pointer-events: none` keeps it
 * click-transparent so the trigger stays clickable under the open tooltip.
 * If a host ancestor does create a fixed-position containing block
 * (transform/filter/zoom), the layer's own window origin is measured and
 * subtracted from the trigger frame, so placement stays window-accurate.
 * Native keeps the Modal, which is what Android's tap-to-dismiss needs and
 * which has no web focus-trap semantics.
 *
 * One overlay instance is mounted once per tooltip-bearing component and
 * kept mounted for its lifetime; only the `open` flag and the bubble content
 * toggle. This is deliberate: mounting/unmounting a focus-trapping Modal per
 * open is what let the web host's focus restore re-focus the trigger after
 * every close, which re-opened the tooltip (flicker), and per-frame
 * measureInWindow churn re-positioned the bubble from sub-pixel noise
 * (shaking). Instead the trigger is measured once when the tooltip opens and
 * only re-measured on real events (scroll/resize, rAF-coalesced) plus a slow
 * heartbeat while open; sub-pixel noise is snapped to whole pixels and can
 * never pass the update guard.
 *
 * The overlay is pointer-transparent so it never steals hover, focus or
 * clicks (on Android, where modal windows always consume touches, the first
 * tap dismisses the tooltip instead). */
function TooltipOverlay({ targetRef, text, theme, layout, onClose, testID, open }: {
  targetRef: RefObject<View | null>;
  text: string;
  theme: PanelTheme;
  layout: PanelLayout;
  onClose: () => void;
  testID: string;
  open: boolean;
}) {
  const [frame, setFrame] = useState<WindowFrame | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [bubbleSize, setBubbleSize] = useState<{ width: number; height: number } | null>(null);
  const lastFrame = useRef<WindowFrame | null>(null);
  const layerRef = useRef<View | null>(null);
  // The web fixed layer's own window origin. Normally (0, 0) — the layer is
  // viewport-anchored — but if a host ancestor creates a fixed-position
  // containing block (transform/filter/zoom), the layer is inset within the
  // window and the trigger frame must be offset by it to stay window-accurate.
  const layerOrigin = useRef({ x: 0, y: 0 });

  // While the tooltip is open, keep the bubble pinned to the trigger: measure
  // on open, then only on scroll (capture phase, so nested ScrollViews are
  // heard), window resize, and a 500ms heartbeat for silent layout shifts —
  // all coalesced so a burst of events costs one re-measure. No per-frame
  // loop: a stationary trigger is measured once and never re-renders, and
  // snapWindowFrame rounds sub-pixel noise away so the update guard only
  // fires when the trigger actually moved. Rapid trigger switches (Segmented)
  // re-run this effect via the targetRef identity change and re-measure the
  // new trigger.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let raf = 0;
    let pending = false;
    const measure = () => {
      // The web layer may be inset by a host fixed-position containing block;
      // measure its window origin first so trigger frames can be offset.
      if (!native) {
        const layer = layerRef.current;
        if (layer && typeof layer.measureInWindow === "function") {
          try {
            layer.measureInWindow((lx, ly) => {
              layerOrigin.current = { x: Math.round(lx), y: Math.round(ly) };
            });
          } catch {
            // A host measure call must never kill the tracking.
          }
        }
      }
      const target = targetRef.current;
      if (!target || typeof target.measureInWindow !== "function") return;
      try {
        target.measureInWindow((x, y, width, height) => {
          if (!alive) return;
          const next = snapWindowFrame({ x: x - layerOrigin.current.x, y: y - layerOrigin.current.y, width, height });
          const previous = lastFrame.current;
          if (!previous || !windowFrameEquals(previous, next)) {
            lastFrame.current = next;
            setFrame(next);
          }
        });
      } catch {
        // A host measure call must never kill the tracking.
      }
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      raf = requestAnimationFrame(() => {
        pending = false;
        if (alive) measure();
      });
    };
    measure();
    if (typeof window !== "undefined") {
      window.addEventListener("scroll", schedule, true);
      window.addEventListener("resize", schedule);
    }
    const heartbeat = setInterval(measure, 500);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (typeof window !== "undefined") {
        window.removeEventListener("scroll", schedule, true);
        window.removeEventListener("resize", schedule);
      }
      clearInterval(heartbeat);
    };
  }, [open, targetRef]);

  // Placement prefers the bubble above the trigger so a top-row tooltip never
  // covers the row below it; below is the fallback when there is not enough
  // room above, and the bubble is clamped into the viewport when neither side
  // fits. Horizontally the bubble stays centered on the trigger, clamped at
  // the viewport edges. Deterministic: pure function of the measured inputs.
  // Until the measurements settle (or if the host cannot measure at all), an
  // opaque clamped fallback position is used so the tooltip always shows.
  const position = useMemo(() => {
    if (!frame || !viewport || !bubbleSize) return { left: 6, top: 6 };
    return computeTooltipPosition(frame, viewport, bubbleSize);
  }, [frame, viewport, bubbleSize]);

  // Native vs web. On Android the modal window swallows every touch, so the
  // first tap dismisses the tooltip instead of blocking the UI; the
  // pointerEvents prop must also reach the Modal element itself: web modal
  // roots (react-native-web) are full-viewport fixed layers that default to
  // pointer-events auto, which would swallow the pointer and instantly close
  // the tooltip via the trigger's hover-out.
  const native = layout.platform !== "web";
  const android = layout.platform === "android";

  // Web viewport = window size, refreshed on resize (the native path keeps
  // the onLayout-driven viewport of its full-screen Modal view).
  useEffect(() => {
    if (native || typeof window === "undefined") return;
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [native]);

  // Web Escape-to-close (the native Modal path closes via onRequestClose).
  useEffect(() => {
    if (!open || native || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, native, onClose]);

  const viewportHandler = (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) => (current && current.width === width && current.height === height ? current : { width, height }));
  };
  const bubbleHandler = (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width, height } = event.nativeEvent.layout;
    setBubbleSize((current) => (current && current.width === width && current.height === height ? current : { width, height }));
  };
  const bubble = (
    <View style={{ position: "absolute", left: position.left, top: position.top }}>
      <View onLayout={bubbleHandler}>
        <TooltipBubble text={text} theme={theme} layout={layout} />
      </View>
    </View>
  );

  if (native) {
    return (
      <Modal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={onClose}
        pointerEvents={android ? "auto" : "none"}
        testID={testID}
        {...(android ? { statusBarTranslucent: true } : {})}
      >
        {open ? (
          <View
            style={{ flex: 1, pointerEvents: android ? "auto" : "none" }}
            pointerEvents={android ? "auto" : "none"}
            onTouchStart={android ? onClose : undefined}
            onLayout={viewportHandler}
          >
            {bubble}
          </View>
        ) : null}
      </Modal>
    );
  }

  // Web: the fixed pointer-transparent layer, mounted once per component
  // instance (only the bubble content toggles) — no Modal, no portal, no
  // focus trap, nothing to intercept clicks.
  return (
    <View ref={layerRef} style={webTooltipLayerStyle} pointerEvents="none">
      {open ? bubble : null}
    </View>
  );
}

/** Blur event surface the tooltip needs: the DOM-ish `relatedTarget`
 * carried by React Native Web focus events, plus the required `type` every
 * synthetic event has (which also keeps the shape assignable from RN's
 * NativeSyntheticEvent instead of a weak all-optional type). */
type TooltipBlurEvent = {
  type: string;
  relatedTarget?: EventTarget | null;
};

/** True when a blur event moved focus into the given tooltip overlay. The
 * overlay Modal's focus trap pulls focus into the overlay the moment it
 * activates, and that hand-off is not the user leaving the trigger — it must
 * not count as losing the focus source. relatedTarget is authoritative; the
 * document.activeElement fallback covers hosts that deliver blur without
 * it. react-native-web's trap focuses its wrapper element (which carries no
 * testID) when nothing inside the overlay is focusable, so containment is
 * also checked structurally: walking from the testID'd content root up to
 * the trap wrapper (never beyond into the shared modal portal, which would
 * over-match other modals). DOM-only: native hosts (no Element/document)
 * always report false. */
function focusMovedIntoOverlay(event: TooltipBlurEvent, overlayTestID: string): boolean {
  if (typeof Element === "undefined") return false;
  const selector = `[data-testid="${overlayTestID}"]`;
  let target = event.relatedTarget;
  if (!(target instanceof Element) && typeof document !== "undefined") {
    const active = document.activeElement;
    target = active instanceof Element ? active : null;
  }
  if (!(target instanceof Element)) return false;
  if (target.closest(selector) !== null) return true;
  if (typeof document === "undefined") return false;
  const root = document.querySelector(selector);
  if (!(root instanceof Element)) return false;
  let container = root.parentElement;
  // Two levels: the ModalAnimation wrapper and the ModalFocusTrap wrapper.
  for (let depth = 0; container !== null && depth < 2; depth += 1) {
    if (container.contains(target)) return true;
    container = container.parentElement;
  }
  return false;
}

/** React binding for createTooltipVisibilityMachine: one overlay testID per
 * trigger (so focus hand-offs into the trigger's own overlay are
 * recognized), plus stable Pressable handlers. Components mirror the
 * machine's visibility in their own open state: open on hoverIn/focusIn,
 * close via the onClose callback — never on the leaving event itself. */
function useTooltipVisibility(onClose: () => void) {
  const overlayTestID = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const machine = useMemo(() => createTooltipVisibilityMachine(() => onCloseRef.current()), []);
  useEffect(() => machine.dispose, [machine]);
  const focusOut = useCallback(
    (event: TooltipBlurEvent) => {
      // The overlay Modal's own focus trap takes focus the moment it
      // mounts; that hand-off is not the user leaving the trigger.
      if (focusMovedIntoOverlay(event, overlayTestID)) return true;
      machine.focusOut(false);
      return false;
    },
    [machine, overlayTestID],
  );
  return {
    /** testID to pass to TooltipOverlay so focus hand-offs into the overlay can be recognized. */
    overlayTestID,
    isActive: machine.isActive,
    hoverIn: machine.hoverIn,
    hoverOut: machine.hoverOut,
    focusIn: machine.focusIn,
    focusOut,
    dismiss: machine.dismiss,
  };
}

export function ActionButton({ label, tooltip, onPress, variant, theme, layout, disabled = false, stretch = false }: {
  label: string;
  tooltip?: string;
  onPress: () => void;
  variant: ButtonVariant;
  theme: PanelTheme;
  layout: PanelLayout;
  disabled?: boolean;
  stretch?: boolean;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const tooltipVisibility = useTooltipVisibility(() => setTooltipOpen(false));
  const showTooltip = tooltip ? tooltipOpen : false;
  const button = {
    primary: {
      backgroundColor: c.accent,
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
    secondary: {
      borderWidth: 1,
      borderColor: withAlpha(c.accent, 0.5),
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
    ghost: {
      borderWidth: 1,
      borderColor: withAlpha(c.foregroundMuted, 0.35),
      paddingVertical: 8,
      paddingHorizontal: compact ? 10 : 12,
      minHeight: compact ? 40 : 36,
    },
    danger: {
      borderWidth: 1,
      borderColor: withAlpha(c.statusDanger, 0.55),
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
  } as const;
  const text = {
    primary: { color: c.accentForeground, fontSize: 12.5, fontWeight: "700" as const },
    secondary: { color: c.accent, fontSize: 12.5, fontWeight: "600" as const },
    ghost: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    danger: { color: c.statusDanger, fontSize: 12.5, fontWeight: "600" as const },
  };
  return (
    <>
      <View style={{ alignItems: stretch ? "stretch" : "flex-start", alignSelf: stretch ? "stretch" : undefined }}>
        <Pressable
          ref={triggerRef}
          accessibilityRole="button"
          accessibilityHint={tooltip}
          onHoverIn={tooltip ? () => { tooltipVisibility.hoverIn(); setTooltipOpen(true); } : undefined}
          onHoverOut={tooltip ? tooltipVisibility.hoverOut : undefined}
          onFocus={tooltip ? () => { tooltipVisibility.focusIn(); setTooltipOpen(true); } : undefined}
          onBlur={tooltip ? tooltipVisibility.focusOut : undefined}
          disabled={disabled}
          onPress={onPress}
          style={[
            { borderRadius: 7, justifyContent: "center", alignItems: "center", alignSelf: stretch ? "stretch" : "flex-start" },
            button[variant],
            disabled ? { opacity: 0.45 } : null,
          ]}
        >
          <Text style={text[variant]}>{label}</Text>
        </Pressable>
      </View>
      {tooltip ? (
        <TooltipOverlay open={showTooltip} targetRef={triggerRef} text={tooltip} theme={theme} layout={layout} onClose={() => { tooltipVisibility.dismiss(); setTooltipOpen(false); }} testID={tooltipVisibility.overlayTestID} />
      ) : null}
    </>
  );
}

export function Segmented<T extends string>({ options, value, onChange, theme, layout, stretch = false }: {
  options: ReadonlyArray<{ value: T; label: string; tooltip?: string }>;
  value: T;
  onChange: (value: T) => void;
  theme: PanelTheme;
  layout: PanelLayout;
  stretch?: boolean;
}) {
  const [hovered, setHovered] = useState<T | null>(null);
  const [focused, setFocused] = useState<T | null>(null);
  const triggerRefs = useRef<Record<string, View | null>>({});
  const tooltipVisibility = useTooltipVisibility(() => {
    setHovered(null);
    setFocused(null);
  });
  // Getter-style ref: always resolves to the currently open option's node
  // (hover wins over focus), so the shared overlay measures the right
  // trigger on every switch.
  const openValue = hovered ?? focused;
  const openOption = options.find((option) => option.value === openValue) ?? null;
  const hoveredTarget = useMemo<RefObject<View | null>>(
    () => ({
      get current() {
        return openValue === null ? null : triggerRefs.current[openValue] ?? null;
      },
    }),
    [openValue],
  );
  return (
    <View style={{ alignSelf: stretch ? "stretch" : undefined, flexDirection: "row", borderWidth: 1, borderColor: withAlpha(theme.colors.foregroundMuted, 0.3), borderRadius: 8, padding: 2, gap: 2 }}>
      {options.map((option) => {
        const active = option.value === value;
        // Safe label fallback: every option still exposes a tooltip.
        const tip = option.tooltip ?? option.label;
        return (
          <View key={option.value} style={stretch ? { flex: 1 } : undefined}>
            <Pressable
              ref={(node) => {
                triggerRefs.current[option.value] = node;
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityHint={tip}
              onHoverIn={() => { tooltipVisibility.hoverIn(); setHovered(option.value); }}
              onHoverOut={() => {
                tooltipVisibility.hoverOut();
                // Keyboard focus still holds the tooltip: drop this option's
                // value so the overlay switches to the focused option instead
                // of waiting for the close timer.
                if (tooltipVisibility.isActive()) setHovered((current) => (current === option.value ? null : current));
              }}
              onFocus={() => { tooltipVisibility.focusIn(); setFocused(option.value); }}
              onBlur={(event) => {
                // A blur whose focus moved into the overlay's own focus trap
                // is not a real source loss and leaves this option untouched.
                if (tooltipVisibility.focusOut(event)) return;
                if (tooltipVisibility.isActive()) setFocused((current) => (current === option.value ? null : current));
              }}
              onPress={() => onChange(option.value)}
              style={{ borderRadius: 6, paddingVertical: layout.compact ? 4 : 5, paddingHorizontal: layout.compact ? 8 : 10, backgroundColor: active ? theme.colors.accent : undefined }}
            >
              <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600", textAlign: stretch ? "center" : undefined }}>{option.label}</Text>
            </Pressable>
          </View>
        );
      })}
      <TooltipOverlay
        open={openOption !== null}
        targetRef={hoveredTarget}
        text={openOption === null ? "" : openOption.tooltip ?? openOption.label}
        theme={theme}
        layout={layout}
        onClose={() => { tooltipVisibility.dismiss(); setHovered(null); setFocused(null); }}
        testID={tooltipVisibility.overlayTestID}
      />
    </View>
  );
}

/**
 * Wraps a single Pressable in the shared top-level hover/focus tooltip — the
 * same overlay ActionButton and Segmented render — without restyling the
 * control or touching its own handlers.
 */
export function HoverTooltip({ text, theme, layout, children }: {
  text: string;
  theme: PanelTheme;
  layout: PanelLayout;
  children: ReactElement<ComponentProps<typeof Pressable>>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const tooltipVisibility = useTooltipVisibility(() => setOpen(false));
  const child = Children.only(children);
  const { onHoverIn, onHoverOut, onFocus, onBlur, accessibilityHint } = child.props;
  const chain = <E,>(...handlers: Array<((event: E) => void) | null | undefined>): ((event: E) => void) | undefined => {
    const active = handlers.filter((handler): handler is (event: E) => void => typeof handler === "function");
    if (active.length === 0) return undefined;
    return (event: E) => {
      for (const handler of active) handler(event);
    };
  };
  return (
    <>
      {cloneElement(child, {
        ref: triggerRef,
        accessibilityHint: accessibilityHint ?? text,
        onHoverIn: chain(onHoverIn, () => { tooltipVisibility.hoverIn(); setOpen(true); }),
        onHoverOut: chain(onHoverOut, tooltipVisibility.hoverOut),
        onFocus: chain(onFocus, () => { tooltipVisibility.focusIn(); setOpen(true); }),
        onBlur: chain(onBlur, (event) => { tooltipVisibility.focusOut(event); }),
      })}
      {text ? (
        <TooltipOverlay open={open} targetRef={triggerRef} text={text} theme={theme} layout={layout} onClose={() => { tooltipVisibility.dismiss(); setOpen(false); }} testID={tooltipVisibility.overlayTestID} />
      ) : null}
    </>
  );
}

/**
 * Full-row select control: a bordered field that opens a centered modal list.
 * Value selection is a real picker interaction, not a row of chips.
 */
export function DropdownSelect({ label, value, options, onChange, placeholder, closeLabel, triggerHint, closeHint, theme, layout }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder: string;
  closeLabel: string;
  triggerHint?: string;
  closeHint?: string;
  theme: PanelTheme;
  layout: PanelLayout;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? null;
  // Semi-transparent, theme-derived backdrop that dims the content behind the card.
  const backdrop = withAlpha(c.foreground, 0.45);
  return (
    <>
      <HoverTooltip text={triggerHint ?? label} theme={theme} layout={layout}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen(true)}
          style={{
            minHeight: 38,
            flexDirection: "row",
            alignItems: "center",
            gap: compact ? 6 : 8,
            borderWidth: 1,
            borderColor: withAlpha(c.foregroundMuted, 0.3),
            borderRadius: 7,
            paddingHorizontal: compact ? 10 : 12,
            paddingVertical: compact ? 7 : 8,
            backgroundColor: withAlpha(c.foreground, 0.03),
          }}
        >
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: compact ? 10 : 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            {label}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }} />
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: selected ? c.foreground : c.foregroundMuted, fontSize: compact ? 12 : 13, fontWeight: selected ? "600" : "400" }}
          >
            {selected?.label ?? value ?? placeholder}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: compact ? 11 : 12 }}>▾</Text>
        </Pressable>
      </HoverTooltip>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: compact ? 12 : 24, backgroundColor: backdrop }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: compact ? undefined : 520,
              maxHeight: compact ? "92%" : "80%",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: withAlpha(c.foregroundMuted, 0.25),
              backgroundColor: c.surface0,
              padding: compact ? 12 : 16,
              gap: compact ? 8 : 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: compact ? 13 : 15, fontWeight: "700" }}>{label}</Text>
              <HoverTooltip text={closeHint ?? closeLabel} theme={theme} layout={layout}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setOpen(false)}
                  style={{ borderWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.35), borderRadius: 999, paddingHorizontal: compact ? 8 : 10, paddingVertical: compact ? 3 : 4 }}
                >
                  <Text style={{ color: c.foregroundMuted, fontSize: compact ? 10.5 : 11.5, fontWeight: "600" }}>{closeLabel}</Text>
                </Pressable>
              </HoverTooltip>
            </View>
            {options.length > 0 ? (
              <ScrollView style={{ maxHeight: compact ? 360 : 420 }} contentContainerStyle={{ gap: 2, paddingVertical: 2 }}>
                {options.map((option) => {
                  const active = option.value === value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      onPress={() => {
                        onChange(option.value);
                        setOpen(false);
                      }}
                      style={{
                        minHeight: 40,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        borderRadius: 7,
                        paddingHorizontal: compact ? 10 : 12,
                        paddingVertical: compact ? 6 : 8,
                        backgroundColor: active ? c.accent : undefined,
                      }}
                    >
                      <Text numberOfLines={2} style={{ flex: 1, color: active ? c.accentForeground : c.foreground, fontSize: compact ? 12.5 : 13.5, fontWeight: active ? "600" : "400" }}>
                        {option.label}
                      </Text>
                      {active ? (
                        <Text style={{ color: c.accentForeground, fontSize: compact ? 12 : 13, fontWeight: "700" }}>✓</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={{ color: c.foregroundMuted, fontSize: compact ? 12 : 13, lineHeight: 18, paddingVertical: 6 }}>{placeholder}</Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function StringGroup({ label, items, t, styles }: {
  label: string;
  items: readonly string[];
  t: TFunc;
  styles: PanelStyles;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      {items.map((item, index) => (
        <View key={index} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.body}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export function FindingGroup({ label, findings, t, theme, styles }: {
  label: string;
  findings: Finding[];
  t: TFunc;
  theme: PanelTheme;
  styles: PanelStyles;
}) {
  if (findings.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      {findings.map((finding) => (
        <View key={finding.id} style={styles.bulletRow}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: severityColor(finding.severity, theme), marginTop: 6 }} />
          <View style={styles.bulletContent}>
            <Text style={[styles.body, { fontWeight: "600" }]}>{finding.summary}</Text>
            <Text style={styles.muted}>{finding.detail}</Text>
            {finding.suggestedCheck ? <Text style={styles.muted}>{t("checkSuggestion", { check: finding.suggestedCheck })}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}
