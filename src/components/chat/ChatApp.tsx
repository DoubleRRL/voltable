"use client";

import { useEffect, useState } from "react";

import { Bookmark } from "lucide-react";

import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { useShape } from "@/lib/shape-context";
import { surfaceClasses } from "@/lib/surface-classes";
import { FigureCarousel } from "@/components/iso/FigureCarousel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

import { Composer } from "./Composer";
import { SavedList } from "./SavedList";
import { useSavedAnswers, type SavedAnswer } from "./useSavedAnswers";
import { MessageList } from "./MessageList";
import { ThemeToggle } from "./ThemeToggle";
import { useChat } from "./useChat";

/**
 * The chat shell: header filters, the transcript, the evidence rail, and the
 * composer. State lives in `useChat`; everything below it is presentational.
 */
export function ChatApp() {
  const {
    messages,
    input,
    busy,
    history,
    duplicateQuestion,
    setInput,
    sendQuestion,
    startNewChat,
    stop,
  } = useChat();

  const shape = useShape();
  const hasConversation = messages.length > 0;
  const { saved, save, remove, clear, isSaved } = useSavedAnswers();
  const [savedOpen, setSavedOpen] = useState(false);

  // A save only makes sense once the answer has settled.
  const handleSave = (entry: Omit<SavedAnswer, "savedAt">) => {
    if (!entry.question) return;
    save({ ...entry, question: entry.question });
  };

  useEffect(() => {
    document.title = hasConversation
      ? "ESR Assistant — working"
      : "ESR Assistant";
  }, [hasConversation]);

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col">
        {/* Edge controls, not a header bar. The actions hug the top-right
            corner in their own pill so transcript text sliding underneath
            stays readable; Saved opens as a dialog because a saved answer
            is a destination you scroll through, not a mode the page
            switches into. */}
        <div
          className={cn(
            "fixed right-3 top-3 z-40 flex items-center gap-1 p-1",
            surfaceClasses(1, 2),
            shape.container
          )}
        >
          <Tooltip
            content={saved.length > 0 ? `Saved answers (${saved.length})` : "Saved answers"}
            side="bottom"
          >
            <Button
              type="button"
              variant="tertiary"
              size="icon"
              onClick={() => setSavedOpen(true)}
              aria-label={saved.length > 0 ? `Saved answers (${saved.length})` : "Saved answers"}
            >
              <Bookmark size={16} strokeWidth={1.5} aria-hidden />
              {saved.length > 0 ? (
                <span
                  className={cn(typeClass("micro"), "tabular-nums text-muted-foreground")}
                  aria-hidden
                >
                  {saved.length}
                </span>
              ) : null}
            </Button>
          </Tooltip>
          {hasConversation ? (
            <Button
              type="button"
              variant="tertiary"
              size="compact"
              disabled={busy}
              onClick={startNewChat}
            >
              New chat
            </Button>
          ) : null}
          <ThemeToggle />
        </div>

        <Dialog open={savedOpen} onOpenChange={setSavedOpen}>
          <DialogContent size="lg" className="max-h-[85dvh] overflow-hidden p-0">
            <DialogHeader className="px-4 py-3">
              <DialogTitle>Saved</DialogTitle>
            </DialogHeader>
            <ScrollArea className="max-h-[70dvh]">
              <SavedList
                saved={saved}
                onRemove={remove}
                onClear={clear}
                onAsk={(question) => {
                  setSavedOpen(false);
                  setInput(question);
                }}
              />
            </ScrollArea>
          </DialogContent>
        </Dialog>

        {!hasConversation ? (
          <main className="flex flex-1 items-center justify-center px-4 py-10">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
              <FigureCarousel />
              <Composer
                narrow
                fieldClassName={cn("mx-auto w-full p-2", surfaceClasses(1, 2), shape.container)}
                value={input}
                onValueChange={setInput}
                onSend={(question) => void sendQuestion(question)}
                onStop={stop}
                busy={busy}
                history={history}
              />
            </div>
          </main>
        ) : (
          <main className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-14">
            <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4">
              <MessageList messages={messages} onSave={handleSave} isSaved={isSaved} />
              <Composer
                fieldClassName={cn("sticky bottom-0 flex flex-col gap-1 pt-2", surfaceClasses(1, 2))}
                value={input}
                onValueChange={setInput}
                onSend={(question) => void sendQuestion(question)}
                onStop={stop}
                busy={busy}
                history={history}
              >
                {duplicateQuestion ? (
                  <p role="status" className={cn(typeClass("caption"), "text-muted-foreground")}>
                    Same question as before. The answer below should match the one above.
                  </p>
                ) : null}
              </Composer>
            </div>
          </main>
        )}
      </div>
    </TooltipProvider>
  );
}
