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
 *  "Ask away" placeholder; on click it opens to a modest multi-line box. */
const NARROW_COLLAPSED = 280;
const NARROW_EXPANDED = 440;

/**
 * The question field, wrapping the library's `InputMessage`.
 *
 * The composer stays usable while a request is in flight: `status` swaps its
 * own send button for a Stop control, and the explicit Stop in the action row
 * is what a planner reaches for when the draft already has text in it — the
 * built-in control hides in that case because it would enqueue instead.
 *
 * The shell is a collapsed single-line pill that springs open into a
 * multi-line composer on focus, reverse-engineered from the useLayouts
 * prompt-box: the card height tracks the measured content height, the textarea
 * opens from `minRows` 1 to 3, and it collapses back once the draft is empty.
 * The card is the motion element (not the input wrapper) because the wrapper
 * sits inside the card's padding and cannot outgrow it.
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
    // Collapse back to the pill only when there is nothing to send — a draft
    // keeps the field open so the planner can keep typing.
    if (!value.trim()) setFocused(false);
  };

  // The inner height is content-driven (minRows), so measuring it never feeds
  // back into the shell animation. The card's own padding is read once it is
  // laid out and added on top, which keeps this correct for both card variants.
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
  }, []);

  return (
    <motion.div
      ref={cardRef}
      className={cn("composer-field", fieldClassName)}
      initial={false}
      animate={{
        height: Math.round(innerH + pad),
        // "none", not undefined: the empty-state and conversation composers
        // share one tree position, so React keeps this instance across the
        // switch and framer-motion would otherwise hold the pill's max-width
        // on the full-width conversation field.
        maxWidth: narrow ? (focused ? NARROW_EXPANDED : NARROW_COLLAPSED) : "none",
      }}
      transition={SHELL}
      style={{ overflow: "hidden" }}
    >
      <div ref={innerRef} className="composer-bloom p-1" data-draft={value.trim() ? "true" : "false"}>
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
          minRows={focused ? 3 : 1}
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
