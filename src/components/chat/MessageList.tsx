"use client";

import { useEffect, useRef, useState } from "react";

import { ChatMessage } from "@/components/ui/chat-message";

import { Message } from "./Message";
import type { SavedAnswer } from "./useSavedAnswers";
import type { ChatMessage as ChatEntry } from "./types";

/** How close to the bottom still counts as "following along". */
const STICK_THRESHOLD_PX = 120;

/**
 * The transcript. User turns are the library's bubble; assistant turns are the
 * trail plus the answer card.
 *
 * The list follows the newest entry while a turn streams, so the planner never
 * has to chase the text down the page mid-call — and stops following the
 * moment they scroll up to read, because a transcript that keeps yanking the
 * viewport is not readable while it streams.
 */
type MessageListProps = {
  messages: ChatEntry[];
  /** Omitted where saving is not wired (e.g. a read-only transcript view). */
  onSave?: (entry: Omit<SavedAnswer, "savedAt">) => void;
  isSaved?: (question: string) => boolean;
};

export function MessageList({ messages, onSave, isSaved }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const onScroll = () => {
      const scrolled = window.scrollY + window.innerHeight;
      const height = document.documentElement.scrollHeight;
      setFollowing(height - scrolled <= STICK_THRESHOLD_PX);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (following) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, following]);

  return (
    <div className="flex flex-col gap-2">
      {messages.map((message, index) => {
        if (message.role === "user") {
          return (
            <ChatMessage key={message.id} from="user">
              {message.content}
            </ChatMessage>
          );
        }
        // An answer is saved against the question that produced it, so the
        // assistant turn needs the nearest preceding user turn. The transcript
        // is strictly alternating, so that is the previous entry.
        const question =
          index > 0 && messages[index - 1]?.role === "user"
            ? (messages[index - 1] as ChatEntry & { content: string }).content
            : null;
        return (
          <Message
            key={message.id}
            message={message}
            question={question}
            onSave={onSave}
            saved={question ? isSaved?.(question) : false}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}