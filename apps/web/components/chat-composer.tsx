"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SendIcon } from "./icons";

export function ChatComposer({
  onSend,
  disabled,
  sending,
  prefilledPrompt,
  focusReplyId,
  onClearPrefilledPrompt,
}: {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  sending: boolean;
  prefilledPrompt?: string | null;
  focusReplyId?: string | null;
  onClearPrefilledPrompt?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const handledReplyId = useRef<string | null>(null);
  const text = draft.trim();

  // Refocus after every newly received assistant reply, not on initial history
  // load or every render. Wait until the message input is enabled. Do not
  // interrupt typing an OTP, uploading a file, or interacting with a dialog.
  useEffect(() => {
    if (!focusReplyId || disabled || sending ||
        handledReplyId.current === focusReplyId) return;
    handledReplyId.current = focusReplyId;
    const textarea = textareaRef.current;
    if (!textarea || document.visibilityState !== "visible") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== textarea &&
        (active.matches("input, textarea, select, [contenteditable]") ||
         active.closest('[aria-label="Secure in-chat journey"], [role="dialog"]'))) return;
    textarea.focus({ preventScroll: true });
  }, [focusReplyId, disabled, sending]);

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
      <div className="relative flex items-end gap-2.5 rounded-2xl border border-white/80 bg-white/80 p-2.5 shadow-[0_8px_32px_rgba(15,23,42,0.06)] backdrop-blur-xl ring-1 ring-slate-900/5 transition-all focus-within:border-slate-800 focus-within:bg-white/95 focus-within:ring-4 focus-within:ring-slate-800/10 hover:border-white hover:bg-white/90">
        <textarea
          ref={textareaRef}
          id="chat-message"
          value={draft}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Sara about company setup, trade licenses, visa quotas, or your quotation…"
          maxLength={12000}
          rows={1}
          disabled={disabled || sending}
          aria-describedby="composer-help"
          className="max-h-44 min-h-[2.75rem] min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-[0.9375rem] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
        />

        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          {draft && !disabled && !sending && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                if (textareaRef.current) textareaRef.current.style.height = "auto";
              }}
              className="hidden sm:inline-flex rounded-lg px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
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
              <SendIcon className="size-4.5 text-white" />
            )}
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between px-2 text-[0.72rem] text-zinc-500">
        <span className="hidden sm:inline-flex items-center gap-1.5 font-medium">
          <kbd className="rounded border border-slate-200/90 bg-white/70 backdrop-blur-xs px-1.5 py-0.5 font-sans font-semibold text-slate-700 shadow-2xs">
            Enter ↵
          </kbd>{" "}
          to send ·{" "}
          <kbd className="rounded border border-slate-200/90 bg-white/70 backdrop-blur-xs px-1.5 py-0.5 font-sans font-semibold text-slate-700 shadow-2xs">
            Shift + Enter
          </kbd>{" "}
          for new line
        </span>
        <span className="sm:hidden text-center w-full font-medium">
          Official ANCFZ Regulatory Concierge
        </span>
        {isNearLimit && (
          <span className="text-zinc-800 font-semibold ml-auto">
            {draft.length.toLocaleString()} / 12,000 characters
          </span>
        )}
      </div>
    </form>
  );
}
