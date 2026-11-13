"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SendIcon } from "./icons";

export function ChatComposer({
  onSend,
  disabled,
  sending,
  prefilledPrompt,
  onClearPrefilledPrompt,
}: {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  sending: boolean;
  prefilledPrompt?: string | null;
  onClearPrefilledPrompt?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const text = draft.trim();

  // If a suggestion card passes a prompt, update draft and focus
  useEffect(() => {
    if (prefilledPrompt) {
      setDraft(prefilledPrompt);
      onClearPrefilledPrompt?.();
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
      }
    }
  }, [prefilledPrompt, onClearPrefilledPrompt]);

  // Dynamic textarea height adjustment
  function handleInput(val: string) {
    setDraft(val);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text || text.length > 12000 || disabled || sending || locked.current) return;
    locked.current = true;
    try {
      await onSend(text);
      setDraft("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch {
      // Keep unsent text for explicit retry. Parent displays API error.
    } finally {
      locked.current = false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  const isNearLimit = draft.length > 10000;

  return (
    <form ref={formRef} onSubmit={submit} className="w-full" aria-label="Send a message">
      <label htmlFor="chat-message" className="sr-only">
        Message to Sara
      </label>
      <div className="relative flex items-end gap-2.5 rounded-2xl border border-white/80 bg-white/75 p-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.06)] backdrop-blur-xl transition-all focus-within:bg-white/95 focus-within:border-zinc-800 focus-within:ring-4 focus-within:ring-zinc-800/10 hover:border-white hover:bg-white/85 ring-1 ring-zinc-900/5">
        <textarea
          ref={textareaRef}
          id="chat-message"
          value={draft}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Sara about licenses, company setup, visas, or your ticket..."
          maxLength={12000}
          rows={1}
          disabled={disabled || sending}
          aria-describedby="composer-help"
          className="max-h-44 min-h-[2.75rem] min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-[0.9375rem] leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-60"
        />

        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          {draft && !disabled && !sending && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                if (textareaRef.current) textareaRef.current.style.height = "auto";
              }}
              className="hidden sm:inline-flex rounded-lg px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
            >
              Clear
            </button>
          )}

          <button
            type="submit"
            disabled={disabled || sending || !text}
            aria-label={sending ? "Sending message" : "Send message"}
            className="flex size-10 sm:size-10.5 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white shadow-sm backdrop-blur-xs transition-all hover:bg-zinc-800 hover:shadow-md active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none"
          >
            {sending ? (
              <span
                className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                aria-hidden="true"
              />
            ) : (
              <SendIcon className="size-4.5" />
            )}
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between px-2 text-[0.72rem] text-zinc-400">
        <span className="hidden sm:inline-flex items-center gap-1">
          <kbd className="rounded border border-white/80 bg-white/60 backdrop-blur-xs px-1.5 py-0.5 font-sans font-medium text-zinc-600 shadow-2xs">
            Enter ↵
          </kbd>{" "}
          to send ·{" "}
          <kbd className="rounded border border-white/80 bg-white/60 backdrop-blur-xs px-1.5 py-0.5 font-sans font-medium text-zinc-600 shadow-2xs">
            Shift + Enter
          </kbd>{" "}
          for new line
        </span>
        <span className="sm:hidden text-center w-full">
          Official ANCFZ Customer Assistant
        </span>
        {isNearLimit && (
          <span className="text-amber-600 font-medium ml-auto">
            {draft.length} / 12,000 characters
          </span>
        )}
      </div>
    </form>
  );
}
