'use client';

/**
 * Tarot Reading — main page.
 *
 * State machine:
 *   idle → submitting → clarifying → reading → complete | error
 *
 * The page connects to POST /api/reading and consumes the SSE stream,
 * progressively rendering each stage of the reading as events arrive.
 *
 * No external UI library required — plain Tailwind-equivalent inline styles
 * keep the component self-contained. Replace with your design system later.
 */

import { useState, useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types (subset of lib/orchestrator/types.ts, duplicated here for the client)
// ---------------------------------------------------------------------------

type AppState = 'idle' | 'submitting' | 'clarifying' | 'reading' | 'complete' | 'error';

interface DrawnCard {
  position: 1 | 2 | 3;
  position_label: string;
  card_id: string;
  card_name: string;
  orientation: 'upright' | 'reversed';
}

interface CardInterpretation {
  card_id: string;
  position_label: string;
  interpretation: string;
  keywords: string[];
}

interface ReadingState {
  intention?: string;
  theme_tags?: string[];
  spread?: DrawnCard[];
  interpretations: Map<string, CardInterpretation>;
  narrative?: string;
  core_tension?: string;
  integration_insight?: string;
  reflection_prompts?: string[];
  clarifyingQuestion?: string;
}

// ---------------------------------------------------------------------------
// SSE consumer
// ---------------------------------------------------------------------------

async function startReading(
  userInput: string,
  sessionId: string,
  onEvent: (type: string, payload: unknown) => void,
  signal: AbortSignal,
  isFollowUp = false
): Promise<void> {
  const response = await fetch('/api/reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userInput, sessionId, isFollowUp }),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const event = JSON.parse(data);
        onEvent(event.type, event.payload ?? {});
      } catch {
        // malformed event — skip
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stable session ID for this browser tab
// ---------------------------------------------------------------------------

function getSessionId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = sessionStorage.getItem('tarot_session_id');
  if (!id) {
    id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('tarot_session_id', id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function getArcanaInfo(cardId: string): { symbol: string; label: string } {
  if (cardId.startsWith('major')) return { symbol: '✦', label: 'Major Arcana' };
  if (cardId.startsWith('wands')) return { symbol: '⌂', label: 'Wands' };
  if (cardId.startsWith('cups')) return { symbol: '◎', label: 'Cups' };
  if (cardId.startsWith('swords')) return { symbol: '✧', label: 'Swords' };
  if (cardId.startsWith('pentacles')) return { symbol: '◈', label: 'Pentacles' };
  return { symbol: '✦', label: '' };
}

const COURT_RANK: Record<string, string> = {
  page: '11', knight: '12', queen: '13', king: '14',
};
const SUIT_PREFIX: Record<string, string> = {
  wands: 'w', cups: 'c', swords: 's', pentacles: 'p',
};

function cardImagePath(cardId: string): string {
  if (cardId.startsWith('major_')) {
    const num = cardId.split('_')[1].padStart(2, '0');
    return `/cards/m${num}.jpg`;
  }
  const [suit, rank] = cardId.split('_');
  const prefix = SUIT_PREFIX[suit];
  const num = COURT_RANK[rank] ?? rank.padStart(2, '0');
  return `/cards/${prefix}${num}.jpg`;
}

function SpreadCard({ card, index }: { card: DrawnCard; index: number }) {
  const isReversed = card.orientation === 'reversed';
  const { symbol, label } = getArcanaInfo(card.card_id);

  return (
    <div style={styles.spreadCardWrapper}>
      <div style={styles.spreadCardPositionLabel}>{card.position_label}</div>
      <div style={{ perspective: '900px', width: '100%' }}>
        <div
          style={{
            ...styles.spreadCardScene,
            animation: `cardFlip 0.75s ease-in-out ${index * 0.35}s forwards`,
          }}
        >
          <div style={styles.spreadCardBack}>
            <div style={styles.spreadCardBackDecor}>✦</div>
          </div>
          <div style={styles.spreadCardFront}>
            <div
              style={{
                ...styles.spreadCardFrontContent,
                transform: isReversed ? 'rotate(180deg)' : undefined,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cardImagePath(card.card_id)}
                alt={card.card_name}
                style={styles.spreadCardImage}
              />
              <div style={styles.spreadCardNameOverlay}>
                <div style={styles.spreadCardName}>{card.card_name}</div>
                {label && <div style={styles.spreadCardArcana}>{label}</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
      {isReversed && <div style={styles.reversedLabel}>역방향</div>}
    </div>
  );
}

function InterpretationBlock({ interp, card }: { interp: CardInterpretation; card?: DrawnCard }) {
  return (
    <div style={styles.interpretationBlock}>
      <div style={styles.interpretationHeader}>
        <strong>{interp.position_label}</strong>
        {card && (
          <span style={styles.cardNameSmall}>
            {card.card_name}
            {card.orientation === 'reversed' && ' (reversed)'}
          </span>
        )}
      </div>
      <p style={styles.interpretationText}>{interp.interpretation}</p>
      <div style={styles.keywordRow}>
        {interp.keywords.map((kw) => (
          <span key={kw} style={styles.keyword}>{kw}</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function TarotPage() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [inputValue, setInputValue] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [reading, setReading] = useState<ReadingState>({ interpretations: new Map() });

  const abortRef = useRef<AbortController | null>(null);
  const sessionId = useRef<string>('');

  // Initialise session ID on first render (client-only)
  if (typeof window !== 'undefined' && !sessionId.current) {
    sessionId.current = getSessionId();
  }

  const handleEvent = useCallback((type: string, payload: Record<string, unknown>) => {
    switch (type) {
      case 'clarification.needed':
        setReading((prev) => ({
          ...prev,
          clarifyingQuestion: (payload.question as string | undefined) ?? undefined,
        }));
        setAppState('clarifying');
        break;

      case 'intention.confirmed':
        setReading((prev) => ({
          ...prev,
          intention: payload.intention as string,
          theme_tags: payload.theme_tags as string[],
        }));
        setAppState('reading');
        break;

      case 'cards.dealt':
        setReading((prev) => ({
          ...prev,
          spread: payload.spread as DrawnCard[],
        }));
        break;

      case 'interpretation.complete': {
        // payload only carries card_id/position_label — the full interp
        // arrives via synthesis. We note the completion for progress display.
        break;
      }

      case 'synthesis.complete':
        setReading((prev) => ({
          ...prev,
          narrative: payload.narrative as string,
          core_tension: payload.core_tension as string,
          integration_insight: payload.integration_insight as string,
        }));
        break;

      case 'reflection.complete':
        setReading((prev) => ({
          ...prev,
          reflection_prompts: payload.reflection_prompts as string[],
        }));
        setAppState('complete');
        break;

      case 'reading.error':
        setErrorMessage((payload.message as string) ?? 'An unexpected error occurred.');
        setAppState('error');
        break;

      default:
        break;
    }
  }, []);

  const submitReading = useCallback(async (input: string, isFollowUp = false) => {
    if (!input.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAppState('submitting');
    setErrorMessage('');
    if (!isFollowUp) setReading({ interpretations: new Map() });
    setInputValue('');

    try {
      await startReading(
        input,
        sessionId.current,
        handleEvent as (type: string, payload: unknown) => void,
        controller.signal,
        isFollowUp
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
      setAppState('error');
    }
  }, [handleEvent]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const isFollowUp = appState === 'clarifying';
    submitReading(inputValue, isFollowUp);
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setAppState('idle');
    setInputValue('');
    setErrorMessage('');
    setReading({ interpretations: new Map() });
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
    <style>{`
      @keyframes cardFlip {
        from { transform: rotateY(0deg); }
        to   { transform: rotateY(180deg); }
      }
    `}</style>
    <main style={styles.main}>
      <div style={styles.container}>
        <header style={styles.header}>
          <h1 style={styles.title}>Tarot Reading</h1>
          <p style={styles.subtitle}>
            Bring a question or a feeling to the cards.
          </p>
        </header>

        {/* Input form — shown in idle / clarifying states */}
        {(appState === 'idle' || appState === 'clarifying' || appState === 'submitting') && (
          <form onSubmit={handleSubmit} style={styles.form}>
            {appState === 'clarifying' && (
              <p style={styles.clarificationNote}>
                {reading.clarifyingQuestion ?? 'The cards need a bit more to work with. Can you say more about what\'s on your mind?'}
              </p>
            )}
            <textarea
              style={styles.textarea}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="What's on your mind? A question, a situation, a feeling…"
              rows={4}
              disabled={appState === 'submitting'}
              autoFocus
            />
            <button
              type="submit"
              style={{
                ...styles.button,
                ...(appState === 'submitting' ? styles.buttonDisabled : {}),
              }}
              disabled={appState === 'submitting' || !inputValue.trim()}
            >
              {appState === 'submitting' ? 'Reading the cards…' : 'Draw the cards'}
            </button>
          </form>
        )}

        {/* Reading in progress */}
        {(appState === 'reading' || appState === 'complete') && (
          <div style={styles.readingContainer}>
            {/* Intention */}
            {reading.intention && (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>Your intention</h2>
                <p style={styles.intentionText}>{reading.intention}</p>
                {reading.theme_tags && reading.theme_tags.length > 0 && (
                  <div style={styles.keywordRow}>
                    {reading.theme_tags.map((tag) => (
                      <span key={tag} style={styles.themeTag}>{tag}</span>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Cards dealt */}
            {reading.spread && (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>The spread</h2>
                <div style={styles.spreadRow}>
                  {reading.spread.map((card, i) => (
                    <SpreadCard key={card.card_id} card={card} index={i} />
                  ))}
                </div>
              </section>
            )}

            {/* Synthesis narrative */}
            {reading.narrative ? (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>The reading</h2>
                <p style={styles.narrativeText}>{reading.narrative}</p>

                {reading.core_tension && (
                  <div style={styles.insightBox}>
                    <span style={styles.insightLabel}>Core tension</span>
                    <p style={styles.insightText}>{reading.core_tension}</p>
                  </div>
                )}

                {reading.integration_insight && (
                  <div style={styles.insightBox}>
                    <span style={styles.insightLabel}>Integration</span>
                    <p style={styles.insightText}>{reading.integration_insight}</p>
                  </div>
                )}
              </section>
            ) : (
              <section style={styles.section}>
                <p style={styles.loadingText}>Interpreting the cards…</p>
              </section>
            )}

            {/* Reflection prompts */}
            {reading.reflection_prompts && reading.reflection_prompts.length > 0 && (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>To sit with</h2>
                <ol style={styles.promptList}>
                  {reading.reflection_prompts.map((prompt, i) => (
                    <li key={i} style={styles.promptItem}>{prompt}</li>
                  ))}
                </ol>
              </section>
            )}

            {/* New reading button */}
            {appState === 'complete' && (
              <div style={styles.resetRow}>
                <button onClick={handleReset} style={styles.resetButton}>
                  Begin a new reading
                </button>
              </div>
            )}
          </div>
        )}

        {/* Error state */}
        {appState === 'error' && (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{errorMessage || 'Something went wrong. Please try again.'}</p>
            <button onClick={handleReset} style={styles.button}>Try again</button>
          </div>
        )}
      </div>
    </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles — minimal, no external dependency
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100vh',
    backgroundColor: '#0e0c15',
    color: '#e8e4d9',
    fontFamily: '"Georgia", "Times New Roman", serif',
    padding: '2rem 1rem',
  },
  container: {
    maxWidth: '680px',
    margin: '0 auto',
  },
  header: {
    textAlign: 'center',
    marginBottom: '2.5rem',
  },
  title: {
    fontSize: '2rem',
    fontWeight: 400,
    letterSpacing: '0.1em',
    color: '#c9b88a',
    margin: 0,
  },
  subtitle: {
    fontSize: '1rem',
    color: '#8a8070',
    marginTop: '0.5rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  clarificationNote: {
    color: '#c9b88a',
    fontStyle: 'italic',
    fontSize: '0.95rem',
    margin: 0,
  },
  textarea: {
    width: '100%',
    backgroundColor: '#1a1728',
    border: '1px solid #3a3550',
    borderRadius: '6px',
    color: '#e8e4d9',
    fontFamily: 'inherit',
    fontSize: '1rem',
    padding: '0.85rem 1rem',
    resize: 'vertical',
    outline: 'none',
    boxSizing: 'border-box',
  },
  button: {
    backgroundColor: '#3d2e6e',
    color: '#e8e4d9',
    border: 'none',
    borderRadius: '6px',
    padding: '0.75rem 1.5rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    cursor: 'pointer',
    alignSelf: 'flex-start',
    letterSpacing: '0.04em',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  readingContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2rem',
  },
  section: {
    borderTop: '1px solid #2a2540',
    paddingTop: '1.5rem',
  },
  sectionTitle: {
    fontSize: '0.75rem',
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    color: '#8a8070',
    margin: '0 0 1rem 0',
    fontWeight: 400,
  },
  intentionText: {
    fontSize: '1.1rem',
    lineHeight: 1.65,
    color: '#e8e4d9',
    margin: '0 0 0.75rem 0',
    fontStyle: 'italic',
  },
  spreadRow: {
    display: 'flex',
    gap: '1rem',
    justifyContent: 'center',
  },
  spreadCardWrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
    minWidth: '130px',
    maxWidth: '190px',
  },
  spreadCardPositionLabel: {
    fontSize: '0.68rem',
    letterSpacing: '0.15em',
    textTransform: 'uppercase' as const,
    color: '#8a8070',
    marginBottom: '0.75rem',
  },
  spreadCardScene: {
    position: 'relative' as const,
    width: '100%',
    aspectRatio: '0.58',
    transformStyle: 'preserve-3d' as const,
  },
  spreadCardBack: {
    position: 'absolute' as const,
    inset: 0,
    borderRadius: '8px',
    border: '1px solid rgba(201,184,138,0.2)',
    backgroundColor: '#0e0a1e',
    backgroundImage: 'radial-gradient(ellipse at center, #1e1040 0%, #0e0a1e 70%)',
    backfaceVisibility: 'hidden' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spreadCardBackDecor: {
    fontSize: '2.5rem',
    color: 'rgba(201,184,138,0.12)',
    userSelect: 'none' as const,
  },
  spreadCardFront: {
    position: 'absolute' as const,
    inset: 0,
    borderRadius: '8px',
    border: '1px solid rgba(201,184,138,0.3)',
    backgroundColor: '#130e22',
    backgroundImage: 'radial-gradient(ellipse at top, #1e1535 0%, #130e22 70%)',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    backfaceVisibility: 'hidden' as const,
    transform: 'rotateY(180deg)',
  },
  spreadCardFrontContent: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'flex-end',
    position: 'relative' as const,
    overflow: 'hidden',
  },
  spreadCardImage: {
    position: 'absolute' as const,
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  spreadCardNameOverlay: {
    position: 'relative' as const,
    zIndex: 1,
    width: '100%',
    textAlign: 'center' as const,
    padding: '0.4rem 0.5rem 0.5rem',
    background: 'linear-gradient(transparent, rgba(10,7,22,0.92) 30%)',
  },
  spreadCardSymbol: {
    fontSize: '1.2rem',
    color: 'rgba(201,184,138,0.35)',
    userSelect: 'none' as const,
  },
  spreadCardCenter: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.4rem',
  },
  spreadCardName: {
    fontSize: '0.9rem',
    color: '#c9b88a',
    textAlign: 'center' as const,
    lineHeight: 1.4,
    fontStyle: 'italic',
  },
  spreadCardArcana: {
    fontSize: '0.6rem',
    letterSpacing: '0.15em',
    textTransform: 'uppercase' as const,
    color: '#5a5060',
  },
  reversedLabel: {
    fontSize: '0.62rem',
    color: '#8a8070',
    marginTop: '0.5rem',
    letterSpacing: '0.1em',
  },
  cardNameSmall: {
    fontSize: '0.85rem',
    color: '#8a8070',
    marginLeft: '0.5rem',
  },
  interpretationBlock: {
    marginBottom: '1.25rem',
  },
  interpretationHeader: {
    marginBottom: '0.5rem',
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.5rem',
  },
  interpretationText: {
    fontSize: '0.95rem',
    lineHeight: 1.7,
    color: '#ccc8bc',
    margin: '0 0 0.5rem 0',
  },
  narrativeText: {
    fontSize: '1rem',
    lineHeight: 1.75,
    color: '#ccc8bc',
    margin: '0 0 1.25rem 0',
  },
  insightBox: {
    backgroundColor: '#1a1728',
    border: '1px solid #2a2540',
    borderRadius: '6px',
    padding: '0.85rem 1rem',
    marginBottom: '0.75rem',
  },
  insightLabel: {
    fontSize: '0.7rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#8a8070',
    display: 'block',
    marginBottom: '0.35rem',
  },
  insightText: {
    fontSize: '0.9rem',
    lineHeight: 1.65,
    color: '#ccc8bc',
    margin: 0,
  },
  promptList: {
    margin: 0,
    paddingLeft: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  promptItem: {
    fontSize: '0.95rem',
    lineHeight: 1.65,
    color: '#ccc8bc',
  },
  keywordRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.4rem',
    marginTop: '0.5rem',
  },
  keyword: {
    backgroundColor: '#1a1728',
    border: '1px solid #3a3550',
    borderRadius: '4px',
    padding: '0.2rem 0.5rem',
    fontSize: '0.75rem',
    color: '#8a8070',
  },
  themeTag: {
    backgroundColor: '#2a1e4e',
    border: '1px solid #4a3a7e',
    borderRadius: '4px',
    padding: '0.2rem 0.5rem',
    fontSize: '0.75rem',
    color: '#c9b88a',
  },
  loadingText: {
    color: '#8a8070',
    fontStyle: 'italic',
    fontSize: '0.95rem',
  },
  resetRow: {
    borderTop: '1px solid #2a2540',
    paddingTop: '1.5rem',
  },
  resetButton: {
    backgroundColor: 'transparent',
    color: '#8a8070',
    border: '1px solid #3a3550',
    borderRadius: '6px',
    padding: '0.6rem 1.25rem',
    fontSize: '0.9rem',
    fontFamily: 'inherit',
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  errorBox: {
    backgroundColor: '#1e0e0e',
    border: '1px solid #5a2a2a',
    borderRadius: '6px',
    padding: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  errorText: {
    color: '#c47a7a',
    margin: 0,
    fontSize: '0.95rem',
  },
};
