"use client";

import { useState } from "react";

import { ChatMessage } from "@/components/ui/chat-message";

import { AnswerCard } from "./AnswerCard";
import type { SavedAnswer } from "./useSavedAnswers";
import type { AssistantMessage } from "./types";

type MessageProps = {
  message: AssistantMessage;
  /** The user turn this answer responds to, or null when unavailable. */
  question: string | null;
  onSave?: (entry: Omit<SavedAnswer, "savedAt">) => void;
  saved?: boolean;
};

/**
 * One assistant turn: the answer itself, with its figure thumbnails and its
 * sources underneath — the way a planner reads them.
 *
 * The retrieval trail used to sit above the answer under a "How this was
 * found" header. It read as a second answer competing with the first, so it
 * is gone: while streaming the card shows the thinking orb, and once settled
 * the answer carries its evidence (thumbnails, then sources) underneath.
 *
 * The transcript keys this component by message id, so the expanded state
 * belongs to one turn: a new answer mounts fresh with the prose folded away.
 */
export function Message({ message, question, onSave, saved }: MessageProps) {
  const [expandedProse, setExpandedProse] = useState(false);

  return (
    <ChatMessage from="assistant" className="max-w-full items-stretch self-stretch">
      <div className="flex w-full flex-col gap-2">
        <AnswerCard
          message={message}
          expandedProse={expandedProse}
          onProseOpenChange={setExpandedProse}
          onSave={
            onSave && question
              ? (entry) => onSave({ ...entry, id: message.id, question })
              : undefined
          }
          saved={saved}
        />
      </div>
    </ChatMessage>
  );
}