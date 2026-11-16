import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/chat-cache';
import { fill, languageName, useUiText } from '@/lib/ui-text';

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
  const { language, copy } = useUiText();
  const suggestions = [
    copy.suggestionSentiment,
    copy.suggestionComplaints,
    copy.suggestionQuestions,
  ];
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
          <h2>{copy.askComments}</h2>
          <p>{fill(copy.answersIn, { language: languageName(language, language) })}</p>
        </div>
        {messages.length > 0 && (
          <button
            className="text-button"
            onClick={onClear}
            disabled={sending}
            type="button"
          >
            {copy.clear}
          </button>
        )}
      </div>

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && !sending && (
          <div className="chat-empty">
            <p>{copy.askAnything}</p>
            <div className="chat-suggestions">
              {suggestions.map((suggestion) => (
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
            {copy.readingComments}
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
          placeholder={copy.askPlaceholder}
          maxLength={800}
          disabled={disabled || sending}
        />
        <button type="submit" disabled={disabled || sending || !draft.trim()}>
          {copy.ask}
        </button>
      </form>
    </section>
  );
}
