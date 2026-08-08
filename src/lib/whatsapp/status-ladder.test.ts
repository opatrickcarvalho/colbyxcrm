import { describe, expect, it } from 'vitest';

import {
  isValidStatusTransition,
  ladderLevel,
  RECIPIENT_STATUS_LADDER,
} from './status-ladder';

// This guard runs over two tables with two different vocabularies:
//
//   broadcast_recipients.status  pending | sent | delivered | read | replied | failed
//   messages.status              sending | sent | delivered | read | failed
//
// The ladder was written for the first and then reused for the second,
// which is where `sending` — messages' pre-send state, and the one
// spelling the ladder never listed — got lost.

describe('ladderLevel', () => {
  it('ranks the broadcast ladder in order', () => {
    const levels = RECIPIENT_STATUS_LADDER.map(ladderLevel);
    expect(levels).toEqual([0, 1, 2, 3, 4]);
  });

  it("treats messages' `sending` as the same rung as `pending`", () => {
    expect(ladderLevel('sending')).toBe(ladderLevel('pending'));
  });

  it('returns -1 for a status off the ladder entirely', () => {
    expect(ladderLevel('failed')).toBe(-1);
    expect(ladderLevel('bogus')).toBe(-1);
  });
});

describe('isValidStatusTransition', () => {
  it('allows forward moves', () => {
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true);
    expect(isValidStatusTransition('delivered', 'read')).toBe(true);
    expect(isValidStatusTransition('sending', 'delivered')).toBe(true);
  });

  it('refuses backward moves, so a replayed webhook cannot regress a tick', () => {
    expect(isValidStatusTransition('read', 'delivered')).toBe(false);
    expect(isValidStatusTransition('delivered', 'sent')).toBe(false);
    expect(isValidStatusTransition('sent', 'sent')).toBe(false);
  });

  // The bug this file exists for: a message that failed while still
  // `sending` never reached `failed`, because only `pending`/`sent` were
  // accepted as the origin — and `sending` is what the messages table
  // actually writes before a send resolves. The row sat showing as
  // in-flight forever.
  it('accepts failure from either spelling of "not sent yet"', () => {
    expect(isValidStatusTransition('sending', 'failed')).toBe(true);
    expect(isValidStatusTransition('pending', 'failed')).toBe(true);
    expect(isValidStatusTransition('sent', 'failed')).toBe(true);
  });

  it('refuses failure once the message demonstrably landed', () => {
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false);
    expect(isValidStatusTransition('read', 'failed')).toBe(false);
    expect(isValidStatusTransition('replied', 'failed')).toBe(false);
  });

  it('treats failed as terminal', () => {
    expect(isValidStatusTransition('failed', 'sent')).toBe(false);
    expect(isValidStatusTransition('failed', 'delivered')).toBe(false);
  });

  it('ignores an unrecognised incoming status', () => {
    expect(isValidStatusTransition('sent', 'bogus')).toBe(false);
  });
});
