"use client";

import { useCallback, useEffect, useState } from "react";

import type { Grounding, SourceCitation, FigureEvidence } from "./types";

/**
 * Saved answers.
 *
 * A planner works a queue of customer calls and the same question comes back —
 * "can I put the meter panel on that wall" is asked constantly, and the answer
 * is a number with a page behind it. Re-deriving it every time is wasted work
 * and risks a different answer on a different day, so a saved answer is kept
 * with its citations intact. That is the whole point: a bookmark that lost its
 * citations would be a liability, not a shortcut.
 *
 * Stored in localStorage. This is per-planner scratch data about their own
 * work, not shared state, and the ESR index itself is never duplicated. Only
 * the fields a planner would need to trust it later are kept.
 */

const STORAGE_KEY = "esr.saved.v1";

/** Cap on retained saves. The ESR has a fixed vocabulary of recurring questions;
 *  past a few hundred this is a library, not a shortlist. */
const MAX_SAVED = 200;

export type SavedAnswer = {
  id: string;
  /** The question as asked, verbatim — the thing a planner would search for. */
  question: string;
  /** The assistant's answer prose. */
  answer: string;
  directAnswer: string;
  citations: SourceCitation[];
  figures: FigureEvidence[];
  grounding: Grounding;
  notCovered: boolean;
  savedAt: number;
};

const isSavedAnswer = (value: unknown): value is SavedAnswer => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.question === "string" &&
    typeof v.answer === "string" &&
    Array.isArray(v.citations) &&
    typeof v.savedAt === "number"
  );
};

const readStorage = (): SavedAnswer[] => {
  // Also the SSR path: useState(readStorage) runs on the server during the
  // prerender, where there is no window and no hydration to mismatch.
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter rather than trust: a hand-edited or half-written store must not
    // crash the transcript.
    return parsed.filter(isSavedAnswer).slice(0, MAX_SAVED);
  } catch {
    return [];
  }
};

const writeStorage = (items: SavedAnswer[]) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Private mode or a full quota. The transcript still works; the save just
    // does not survive a reload. Not worth interrupting the call over.
  }
};

/**
 * Saves, and whether a given answer is saved.
 *
 * Storage events keep two windows of the app in agreement, which matters because
 * the launcher can leave a second instance pointed at the same port.
 */
export function useSavedAnswers() {
  // Read lazily on first render rather than in an effect. The server render
  // has no localStorage and yields [], the first client render reads it — and
  // React discards that first client render when it differs, so there is no
  // flash of empty state and no cascading setState.
  const [saved, setSaved] = useState<SavedAnswer[]>(readStorage);

  // Two windows pointed at the same port (the launcher can start a second
  // instance) must not disagree about what is saved.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setSaved(readStorage());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const save = useCallback((entry: Omit<SavedAnswer, "savedAt">) => {
    setSaved((current) => {
      // Re-saving an edited question replaces the old entry rather than
      // stacking duplicates, matched on the question since the message id is
      // not stable across a reload.
      const next = [
        { ...entry, savedAt: Date.now() },
        ...current.filter((item) => item.question !== entry.question),
      ].slice(0, MAX_SAVED);
      writeStorage(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSaved((current) => {
      const next = current.filter((item) => item.id !== id);
      writeStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSaved([]);
    writeStorage([]);
  }, []);

  const isSaved = useCallback(
    (question: string) => saved.some((item) => item.question === question),
    [saved]
  );

  return { saved, save, remove, clear, isSaved };
}