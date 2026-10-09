"use client";

import { useEffect, useRef, useState } from "react";

import { motion } from "framer-motion";

import { InputMessage } from "@/components/ui/input-message";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";

type ComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSend: (question: string) => void;
  onStop: (() => void) | undefined;
  busy: boolean;
  /** Previously sent questions, for ArrowUp recall. */
  history: string[];
  /** Classes for the card that wraps the field — the surface, radius and
   *  padding differ between the empty state and the conversation view, so the
   *  caller owns them and this stays the one place that animates the shell. */
  fieldClassName?: string;
  placeholder?: string;
  className?: string;
  /** Extra content rendered at the top of the card, above the field. */
  children?: React.ReactNode;
  /** Empty-state sizing: a narrow pill that springs open on focus. The
   *  conversation composer is already full-width, so it leaves this off. */
  narrow?: boolean;
};

/** Matches the reference shell: stiffness 400 / damping 25 / mass 1.5. */
const SHELL = { type: "spring", stiffness: 400, damping: 25, mass: 1.5 } as const;

/** Narrow pill → open composer. The resting field is barely wider than the
 *  "Ask away" placeholder; on click it opens a touch wider, and the first
 *  text takes it wider once more — after that only height moves. */
const NARROW_COLLAPSED = 163;
const NARROW_OPEN = 208;
const NARROW_WIDE = 320;

/**
 * The question field, wrapping the library's `InputMessage`.
 *
 * The composer stays usable while a request is in flight: `status` swaps its
 * own send button for a Stop control, and the explicit Stop in the action row
 * is what a planner reaches for when the draft already has text in it — the
 * built-in control hides in that case because it would enqueue instead.
 *
 * The shell is a collapsed single-line pill that springs open on focus,
 * reverse-engineered from the useLayouts prompt-box: the card height tracks
 * the measured content height and it collapses back once the draft is empty.
 * Both states stay single-line (`minRows` 1 — the shell still grows if a
 * draft wraps); the growth is width plus the send/status controls appearing.
 * The footer row hides while the field is empty — the send control is hidden
 * on an empty draft anyway — but never while busy, because the footer carries
 * Stop mid-stream. The card is the motion element (not the input wrapper)
 * because the wrapper sits inside the card's padding and cannot outgrow it.
 */
export function Composer({
  value,
  onValueChange,
  onSend,
  onStop,
  busy,
  history,
  fieldClassName,
  placeholder = "Ask away",
  className,
  children,
  narrow = false,
}: ComposerProps) {
  const [focused, setFocused] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [innerH, setInnerH] = useState(0);
  const [pad, setPad] = useState(24);

  const onFocus = () => setFocused(true);
  const onBlur = () => {
    if (!value.trim()) setFocused(false);
  };
  // The footer (send/stop row) shows only when there is something in the
  // field or a stream to stop. An empty field is one text line, focused or
  // not — the growth on click is width, not height.
  const empty = !value.trim() && !busy;
  // Two-stage growth: focus opens the pill a touch; a draft takes it wider
  // once; after that only height moves as the draft wraps. The draft (not
  // focus) drives the wide stage so tabbing away mid-draft never collapses
  // it — and onBlur already keeps focus while a draft stands.
  const hasDraft = value.trim().length > 0 || busy;

  // The inner height is content-driven (minRows), so measuring it never feeds
  // back into the shell animation. The card's own padding is read whenever the
  // empty state changes, because the pill uses tighter padding.
  useEffect(() => {
    const inner = innerRef.current;
    if (inner) {
      const measure = () => setInnerH(inner.getBoundingClientRect().height);
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(inner);
    }
    const card = cardRef.current;
    if (card) {
      const cs = getComputedStyle(card);
      setPad(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    }
  }, [empty]);

  return (
    <motion.div
      ref={cardRef}
      className={cn("composer-field", empty && "composer-empty", fieldClassName)}
      initial={false}
      animate={{
        height: Math.round(innerH + pad),
        // "none", not undefined: the empty-state and conversation composers
        // share one tree position, so React keeps this instance across the
        // switch and framer-motion would otherwise hold the pill's max-width
        // on the full-width conversation field.
        maxWidth: narrow
          ? !focused
            ? NARROW_COLLAPSED
            : hasDraft
              ? NARROW_WIDE
              : NARROW_OPEN
          : "none",
      }}
      transition={SHELL}
      style={{ overflow: "hidden" }}
    >
      <div
        ref={innerRef}
        className={cn("composer-bloom", empty ? "p-0" : "p-1")}
        data-draft={value.trim() ? "true" : "false"}
        data-empty={empty ? "true" : "false"}
      >
        {children}
        <InputMessage
          className={cn("w-full", className)}
          value={value}
          onValueChange={onValueChange}
          onFocus={onFocus}
          onBlur={onBlur}
          onSend={(question) => onSend(question)}
          status={busy ? "streaming" : "idle"}
          onStop={onStop}
          history={history}
          suggestions={[]}
          placeholder={placeholder}
          minRows={1}
          maxRows={8}
          sendLabel="Send"
          rightSlot={
            busy ? (
              <Button
                type="button"
                variant="tertiary"
                size="compact"
                onClick={onStop}
                className={typeClass("caption")}
              >
                Stop
              </Button>
            ) : undefined
          }
        />
      </div>
    </motion.div>
  );
}
