"use client";

import { forwardRef, type HTMLAttributes } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { cn } from "@/lib/utils";

type ThinkingIndicatorProps = HTMLAttributes<HTMLDivElement>;

// Icon only, by design. A visible word label used to cycle here
// ("Thinking" → "Moonwalking" → …) and took a full row to say what the orb
// already says. The single sr-only announcement below is the whole message
// for assistive tech; everyone else gets the orb.
//
// The orb itself is the shared thinking-orbs package (also used by the
// calctutor coach), not a local reimplementation: dotted thought-orb on
// canvas, monochrome with auto dark/light from the host's `dark` class,
// static frame under prefers-reduced-motion, pauses offscreen. One copy of
// the truth for what "thinking" looks like.
const ThinkingIndicator = forwardRef<HTMLDivElement, ThinkingIndicatorProps>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="status"
        className={cn("inline-flex shrink-0", className)}
        {...props}
      >
        {/* Static announcement — one "Thinking…", never re-announced. */}
        <span className="sr-only">Thinking…</span>
        <ThinkingOrb
          state="working"
          size={20}
          theme="auto"
          aria-hidden="true"
        />
      </div>
    );
  },
);

ThinkingIndicator.displayName = "ThinkingIndicator";

export { ThinkingIndicator };
export type { ThinkingIndicatorProps };
export default ThinkingIndicator;
