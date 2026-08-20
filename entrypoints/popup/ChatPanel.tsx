import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/chat-cache';

const SUGGESTIONS = [
  'What is the overall sentiment?',
  'What are people complaining about?',
  'What questions keep coming up?',
];

interface ChatPanelProps {
  disabled: boolean;
  disabledReason: string;
  sending: boolean;
  error: string | null;
  messages: ChatMessage[];
  onSend: (question: string) => void;
  onClear: () => void;
}

export function ChatPanel({
  disabled,
  disabledReason,
  sending,
  error,
  messages,
  onSend,
  onClear,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, sending]);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || disabled || sending) return;
    setDraft('');
    onSend(trimmed);
  };

  return (
    <section className="chat-card">
      <div className="section-heading">
        <div>
          <h2>Ask the comments</h2>
          <p>Questions use the comments already loaded</p>
        </div>
        {messages.length > 0 && (
          <button
            className="text-button"
            onClick={onClear}
            disabled={sending}
            type="button"
          >
            Clear
          </button>
        )}
      </div>

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && !sending && (
          <div className="chat-empty">
            <p>Ask anything about this discussion.</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chat-chip"
                  disabled={disabled || sending}
                  onClick={() => submit(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div
            className={`chat-bubble chat-${message.role}`}
            key={message.id}
          >
            {message.text}
          </div>
        ))}

        {sending && (
          <div className="chat-bubble chat-assistant chat-pending">
            Reading the comments…
          </div>
        )}
      </div>

      {error && <p className="chat-error">{error}</p>}
      {disabled && disabledReason && (
        <p className="chat-hint">{disabledReason}</p>
      )}

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about these comments"
          maxLength={800}
          disabled={disabled || sending}
        />
        <button type="submit" disabled={disabled || sending || !draft.trim()}>
          Ask
        </button>
      </form>
    </section>
  );
}
