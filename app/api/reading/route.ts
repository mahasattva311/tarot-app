/**
 * POST /api/reading
 *
 * Accepts a JSON body:
 *   { userInput: string; sessionId?: string; spreadType?: 'three_card' }
 *
 * Streams a Server-Sent Events (SSE) response. Each event is a JSON-encoded
 * ReadingEvent as defined in lib/orchestrator/types.ts.
 *
 * The response closes after the 'reflection.complete' event (the reading is
 * fully visible) or a 'reading.error' event. The async 'reading.saved' event
 * may follow, but the frontend can safely close the connection before it.
 *
 * Guest mode: no auth required. persistToDatabase() is a no-op for guests.
 * When a real auth layer is added, derive userId from the session token here.
 */

import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runReadingSession, ClarificationNeededError } from '../../../lib/orchestrator/reading-session';
import { CardDefinition, ReadingEvent } from '../../../lib/orchestrator/types';

// ---------------------------------------------------------------------------
// Card data — loaded once per cold start, shared across requests
// ---------------------------------------------------------------------------

let cardDefinitions: Map<string, CardDefinition> | null = null;

function getCardDefinitions(): Map<string, CardDefinition> {
  if (cardDefinitions) return cardDefinitions;

  const dataPath = join(process.cwd(), 'data', 'cards.json');
  const raw = readFileSync(dataPath, 'utf-8');
  const cards: CardDefinition[] = JSON.parse(raw);

  cardDefinitions = new Map(cards.map((c) => [c.card_id, c]));
  return cardDefinitions;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function encodeEvent(event: ReadingEvent): Uint8Array {
  const payload = JSON.stringify(event);
  return new TextEncoder().encode(`data: ${payload}\n\n`);
}

function encodeDone(): Uint8Array {
  return new TextEncoder().encode(`data: [DONE]\n\n`);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // Parse and validate the request body
  let body: { userInput?: string; sessionId?: string; spreadType?: string; isFollowUp?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { userInput, sessionId, spreadType, isFollowUp } = body;

  if (!userInput || typeof userInput !== 'string' || userInput.trim() === '') {
    return new Response(JSON.stringify({ error: 'userInput is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Guest mode: use a stable per-session user ID.
  // Replace with real auth lookup (e.g. getServerSession) when auth is added.
  const userId = sessionId ?? `guest_${Date.now()}`;
  const resolvedSessionId = sessionId ?? `session_${Date.now()}`;

  let cards: Map<string, CardDefinition>;
  try {
    cards = getCardDefinitions();
  } catch (err) {
    console.error('[reading] Failed to load card definitions:', err);
    return new Response(JSON.stringify({ error: 'Card data unavailable' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build an SSE stream using the Web Streams API (Node 18+ / Next.js edge runtime)
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event: ReadingEvent) => {
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          // Controller may already be closed if the client disconnected
        }
      };

      try {
        await runReadingSession({
          userId,
          sessionId: resolvedSessionId,
          userInput: userInput.trim(),
          spreadType: spreadType === 'three_card' ? 'three_card' : 'three_card',
          cardDefinitions: cards,
          onEvent: enqueue,
          isFollowUp: isFollowUp === true,
        });
      } catch (err) {
        if (err instanceof ClarificationNeededError) {
          // The orchestrator already emitted a 'clarification.needed' event.
          // The client should prompt the user for more input and POST again.
        } else {
          // Unrecoverable error — the orchestrator already emitted 'reading.error'
          console.error('[reading] Unrecoverable error:', err instanceof Error ? err.message : err);
        }
      } finally {
        try {
          controller.enqueue(encodeDone());
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering in production
    },
  });
}
