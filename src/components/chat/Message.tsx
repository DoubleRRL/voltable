"use client";

import { useState } from "react";

import { ChatMessage } from "@/components/ui/chat-message";

import { AnswerCard } from "./AnswerCard";
import { ThinkingTrail } from "./ThinkingTrail";
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
 * One assistant turn: the retrieval trail, then the answer itself.
 *
 * The transcript keys this component by message id, so the expanded state
 * belongs to one turn: a new answer mounts fresh with the prose folded away.
 */
export function Message({ message, question, onSave, saved }: MessageProps) {
  const [expandedProse, setExpandedProse] = useState(false);

  return (
    <ChatMessage from="assistant" className="max-w-full items-stretch self-stretch">
      <div className="flex w-full flex-col gap-2">
        <ThinkingTrail message={message} />
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