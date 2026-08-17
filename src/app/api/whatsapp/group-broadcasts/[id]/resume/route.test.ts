import { describe, it, expect, vi } from 'vitest'

// Same queue-based Supabase mock as ../../route.test.ts — each
// `.from(table)` call consumes the next canned response for that
// table, in the order the route under test actually issues them.
// `.order()` on the targets fetch resolves the query directly (no
// further chain method), matching how the real supabase-js client
// makes a builder awaitable at any point in the chain.
function makeSupabase(responses: Record<string, unknown[]>) {
  const counters: Record<string, number> = {}
  const updateCalls: Record<string, unknown[]> = {}

  function from(table: string) {
    const idx = counters[table] ?? 0
    counters[table] = idx + 1
    const queue = responses[table] ?? []
    const value = queue[idx] ?? queue[queue.length - 1] ?? { data: null, error: null }

    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) {
      b[m] = vi.fn(() => b)
    }
    b.update = vi.fn((payload: unknown) => {
      updateCalls[table] = updateCalls[table] ?? []
      ;(updateCalls[table] as unknown[]).push(payload)
      return b
    })
    b.single = vi.fn(() => Promise.resolve(value))
    b.maybeSingle = vi.fn(() => Promise.resolve(value))
    b.order = vi.fn(() => Promise.resolve(value))
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject)
    return b
  }

  return { from: vi.fn(from), updateCalls }
}

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }))
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))

import { POST } from './route'

function ctx(responses: Record<string, unknown[]>) {
  const supabase = makeSupabase(responses)
  mocks.requireRole.mockResolvedValue({ supabase, accountId: 'acc-1', userId: 'user-1' })
  return supabase
}

function request() {
  return new Request('http://localhost/api/whatsapp/group-broadcasts/bc-1/resume', {
    method: 'POST',
  })
}

function params(id = 'bc-1') {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/whatsapp/group-broadcasts/[id]/resume', () => {
  it('404s when the campaign is not found (or not owned)', async () => {
    ctx({ whatsapp_group_broadcasts: [{ data: null, error: null }] })
    const res = await POST(request(), params())
    expect(res.status).toBe(404)
  })

  it.each(['pending', 'sending', 'sent', 'failed', 'cancelled'])(
    'rejects resuming a campaign that is %s (not paused)',
    async (status) => {
      ctx({ whatsapp_group_broadcasts: [{ data: { id: 'bc-1', status }, error: null }] })
      const res = await POST(request(), params())
      expect(res.status).toBe(400)
    },
  )

  it('re-plans send_at for every still-pending target and flips status back to sending', async () => {
    const supabase = ctx({
      whatsapp_group_broadcasts: [
        {
          data: {
            id: 'bc-1',
            status: 'paused',
            sent_count: 3, // some already went out before it was paused
            delay_seconds: 30,
            delay_jitter_pct: 20,
            window_start: null,
            window_end: null,
            window_days: null,
            timezone: 'America/Sao_Paulo',
          },
          error: null,
        },
        { data: { id: 'bc-1', status: 'sending' }, error: null },
      ],
      whatsapp_group_broadcast_targets: [
        { data: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], error: null },
      ],
    })

    const res = await POST(request(), params())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.status).toBe('sending')

    // 3 pending targets rescheduled + 1 broadcast status flip = 4 updates.
    const targetUpdates = supabase.updateCalls['whatsapp_group_broadcast_targets'] ?? []
    expect(targetUpdates).toHaveLength(3)
    for (const u of targetUpdates) {
      const payload = u as { send_at: string }
      expect(typeof payload.send_at).toBe('string')
      // Re-planned from "now", not left at a stale past timestamp.
      expect(new Date(payload.send_at).getTime()).toBeGreaterThan(Date.now() - 5000)
    }
  })

  it('sets status to pending (not sending) when nothing has sent yet', async () => {
    ctx({
      whatsapp_group_broadcasts: [
        {
          data: {
            id: 'bc-1',
            status: 'paused',
            sent_count: 0,
            delay_seconds: 30,
            delay_jitter_pct: 20,
            window_start: null,
            window_end: null,
            window_days: null,
            timezone: 'America/Sao_Paulo',
          },
          error: null,
        },
        { data: { id: 'bc-1', status: 'pending' }, error: null },
      ],
      whatsapp_group_broadcast_targets: [{ data: [], error: null }],
    })

    const res = await POST(request(), params())
    const json = await res.json()
    expect(json.data.status).toBe('pending')
  })
})
