// ============================================================
// Shared delivery-status ladder, used by both webhook routes
// (Meta's `handleStatusUpdate` and UAZAPI's `messages_update`
// handling) to decide whether an incoming status update is allowed
// to overwrite what's already stored.
//
// Extracted from src/app/api/whatsapp/webhook/route.ts so the two
// providers don't each carry their own (potentially drifting) copy
// of this logic — it has no provider-specific branching, so there's
// nothing UAZAPI- or Meta-shaped about it.
// ============================================================

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once a message
// has been delivered or the user has read or replied, a later
// "failed" status event is a bug in the provider's pipeline or a
// spoof attempt and must be ignored.
export const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

/**
 * The two tables this ladder guards do not share a vocabulary for the
 * first rung. `broadcast_recipients.status` starts at `pending`;
 * `messages.status` starts at `sending` (migration 001's CHECK allows
 * `sending | sent | delivered | read | failed` and has no `pending` at
 * all). The ladder was lifted from the broadcast side, so `sending` fell
 * off the end of it and scored -1 — which made `sending -> failed`
 * refused, leaving a message that failed before it was ever sent stuck
 * showing as in-flight forever.
 *
 * Normalising here rather than adding a rung keeps the two spellings of
 * "not sent yet" at the same level, which is what they mean.
 */
function normalize(s: string): string {
  return s === 'sending' ? 'pending' : s;
}

export function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(
    normalize(s)
  );
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from the pre-delivery states
 *     (`pending`/`sending` or `sent`); it's refused once the recipient
 *     has reached any of the success states.
 */
export function isValidStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    const from = normalize(current);
    return from === 'pending' || from === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}
