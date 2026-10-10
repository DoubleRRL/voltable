"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { motion, useReducedMotion } from "framer-motion";

import { spring } from "@/lib/springs";
import { clamp01 } from "./scatter";

import { PoleFigure } from "./PoleFigure";
import { PadmountFigure } from "./PadmountFigure";
import { SwitchgearFigure } from "./SwitchgearFigure";
import { MeterPanelFigure } from "./MeterPanelFigure";
import { GuyAnchorFigure } from "./GuyAnchorFigure";
import { CutoutFigure } from "./CutoutFigure";
import { PadmountSwitchgearFigure } from "./PadmountSwitchgearFigure";
import { CtCabinetFigure } from "./CtCabinetFigure";
import { RiserFigure } from "./RiserFigure";

type FigureProps = { transition?: { progress: number; phase: "out" | "in" } };
type FigureComponent = (props: FigureProps) => React.JSX.Element;

/**
 * Empty-state equipment figures as a scatter/gather rotation.
 *
 * On advance, the outgoing figure's parts are thrown clear of the figure's own
 * centre and fade, while the incoming figure's parts materialise out where
 * they start and gather in. Rigid pieces in flight — no morphing, no fake part
 * correspondence (a pole wire becoming a padmount door would read as wrong),
 * no tumbling (isokit boxes are axis-aligned, so rotation would mean
 * redrawing geometry every frame). The travel maths is in `iso/scatter.ts`.
 *
 * The two phases OVERLAP rather than cutting: the incoming figure is already
 * gathering while the outgoing one is finishing its throw. Sequenced phases
 * left a frame where the plate held a fully dispersed, fully opaque figure —
 * the exact "chaos" frame that made the previous version unreadable.
 *
 * The whole flight is `TOTAL_MS`, close to the system's slow tier rather than
 * the 1350ms of invented timing this replaces; the dwell is long enough that
 * the rotation is ambient rather than attention-seeking. Pausing freezes
 * accumulated time instead of cancelling, so a resumed flight continues
 * rather than jumping. Presses are inert mid-flight (each figure
 * disables its Press whenever `transition` is defined), and if focus was
 * riding the outgoing figure it moves to this region instead of dropping to
 * the page.
 */
const FIGURES: Array<{ id: string; label: string; Component: FigureComponent }> = [
  { id: "pole", label: "Distribution pole", Component: PoleFigure },
  { id: "padmount", label: "Padmount transformer", Component: PadmountFigure },
  { id: "switchgear", label: "1200 amp switchgear", Component: SwitchgearFigure },
  { id: "meterpanel", label: "Meter panel and service", Component: MeterPanelFigure },
  { id: "guy", label: "Guy wire and anchor", Component: GuyAnchorFigure },
  { id: "cutout", label: "Cutout and arrester", Component: CutoutFigure },
  { id: "pme", label: "PME pad-mount switchgear", Component: PadmountSwitchgearFigure },
  { id: "ctcabinet", label: "CT cabinet and meter", Component: CtCabinetFigure },
  { id: "riser", label: "Riser and U-guard", Component: RiserFigure },
];

const DWELL_MS = 7000;
const OUT_MS = 1600;
const IN_MS = 2000;
/** How long the outgoing figure is still visible after the incoming starts. */
const OVERLAP_MS = 400;
const TOTAL_MS = OUT_MS + IN_MS - OVERLAP_MS;

type Flight = { from: number; to: number; elapsed: number };

export function FigureCarousel() {
  const reduceMotionQuery = useReducedMotion();
  // The server cannot read the motion preference, so it always renders the
  // carousel tree. If the first client render branched on the media query
  // instead, reduced-motion users would hydrate carousel HTML as the static
  // row — React error 418 and a remount. useSyncExternalStore holds the
  // server snapshot (false) through hydration, then flips once, with no
  // setState-in-effect. Motion users never see a swap (same branch before
  // and after); reduced-motion users see one swap to the row.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  const reduceMotion = mounted && reduceMotionQuery;
  const [index, setIndex] = useState(0);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const indexRef = useRef(index);
  const flightRef = useRef<Flight | null>(null);
  const pausedRef = useRef(paused);
  const regionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const beginFlight = useCallback((to: number) => {
    const from = indexRef.current;
    if (from === to || flightRef.current) return;
    flightRef.current = { from, to, elapsed: 0 };
    setFlight({ from, to, elapsed: 0 });
    setProgress(0);
    // A figure mid-flight cannot hold focus (its Press is disabled), so a
    // focused part would strand on an unmounting element. Park focus on the
    // region before anything moves.
    if (regionRef.current?.contains(document.activeElement)) {
      regionRef.current.focus({ preventScroll: true });
    }
  }, []);

  // Dwell timer: idle only.
  useEffect(() => {
    if (reduceMotion || paused || flight) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      beginFlight((indexRef.current + 1) % FIGURES.length);
    }, DWELL_MS);
    return () => window.clearInterval(id);
  }, [reduceMotion, paused, flight, beginFlight, index]);

  // Flight driver. Frames are scheduled ONLY while a flight is live — an
  // always-on rAF loop would burn a compositor frame every 16ms for an
  // empty state that is idle most of the time.
  useEffect(() => {
    if (reduceMotion || !flight) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const f = flightRef.current;
      if (!f) return;
      if (!pausedRef.current && document.visibilityState === "visible") {
        f.elapsed = Math.min(1, f.elapsed + dt / TOTAL_MS);
        setProgress(f.elapsed);
        if (f.elapsed >= 1) {
          indexRef.current = f.to;
          setIndex(f.to);
          flightRef.current = null;
          setFlight(null);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion, flight]);

  if (reduceMotion) {
    return (
      <div
        role="group"
        aria-label="Service equipment"
        className="flex flex-wrap items-start justify-center gap-3"
      >
        {FIGURES.map(({ id, Component }, i) => (
          <motion.div
            key={id}
            initial={{ opacity: 0, y: 14, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ ...spring.moderate, delay: i * 0.06 }}
            className="w-24 sm:w-32"
          >
            <Component />
          </motion.div>
        ))}
      </div>
    );
  }

  const inFlight = flight !== null;
  const settled = FIGURES[index]!;
  // The incoming figure is already gathering during the overlap, so it is
  // what the region's accessible name should point at well before the swap.
  const announced = inFlight ? FIGURES[flight.to]! : settled;

  const outProgress = clamp01(progress / (OUT_MS / TOTAL_MS));
  const inProgress = 1 - clamp01((progress * TOTAL_MS - OVERLAP_MS) / IN_MS);
  const Outgoing = inFlight ? FIGURES[flight.from]!.Component : null;
  const Incoming = inFlight ? FIGURES[flight.to]!.Component : null;

  return (
    <div
      ref={regionRef}
      role="group"
      aria-roledescription="carousel"
      aria-label="Service equipment"
      tabIndex={-1}
      className="flex flex-col items-center gap-2 outline-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
    >
      <span className="sr-only" aria-live="polite">
        {announced.label}
      </span>
      <div className="relative flex h-52 w-full items-center justify-center sm:h-60">
        {Outgoing && Incoming ? (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-48 sm:w-56">
                <Outgoing transition={{ progress: outProgress, phase: "out" }} />
              </div>
            </div>
            <div className="flex w-48 items-center justify-center sm:w-56">
              <Incoming transition={{ progress: inProgress, phase: "in" }} />
            </div>
          </>
        ) : (
          <div className="w-48 sm:w-56">
            <settled.Component />
          </div>
        )}
      </div>
    </div>
  );
}