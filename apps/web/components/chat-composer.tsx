"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export function ChatComposer({
  onSend,
  disabled,
  sending,
}: {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  sending: boolean;
}) {
  const [draft, setDraft] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const locked = useRef(false);
  const text = draft.trim();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text || text.length > 12000 || disabled || sending || locked.current) return;
    locked.current = true;
    try {
      await onSend(text);
      setDraft("");
    } catch {
      // Keep the unsent text for explicit retry. Parent displays the API error.
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

  return (
    <form ref={formRef} onSubmit={submit} className="w-full" aria-label="Send a message">
      <label htmlFor="chat-message" className="sr-only">Message to Sara</label>
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_5px_25px_rgba(15,23,42,0.06)] focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
        <textarea
          id="chat-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type your message…"
          maxLength={12000}
          rows={2}
          disabled={disabled || sending}
          aria-describedby="composer-help"
          className="max-h-44 min-h-12 min-w-0 flex-1 resize-y rounded-xl bg-transparent px-3 py-2.5 text-[0.9375rem] leading-6 text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={disabled || sending || !text}
          aria-label={sending ? "Sending message" : "Send message"}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-blue-700 text-white transition hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {sending ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5"><path d="m5 12 14-8-4 16-3.5-6.5L5 12Z" strokeLinecap="round" strokeLinejoin="round" /><path d="m11.5 13.5 7.5-9.5" strokeLinecap="round" /></svg>}
        </button>
      </div>
      <p id="composer-help" className="mt-2 px-2 text-center text-[0.7rem] text-slate-400">Enter to send · Shift+Enter for a new line</p>
    </form>
  );
}
