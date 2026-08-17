import { describe, it, expect, vi } from 'vitest'

// Same queue-based Supabase mock as ../../route.test.ts — each
// `.from(table)` call consumes the next canned response for that
// table, in the order the route under test actually issues them.
function makeSupabase(responses: Record<string, unknown[]>) {
  const counters: Record<string, number> = {}

  function from(table: string) {
    const idx = counters[table] ?? 0
    counters[table] = idx + 1
    const queue = responses[table] ?? []
    const value = queue[idx] ?? queue[queue.length - 1] ?? { data: null, error: null }

    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update']) {
      b[m] = vi.fn(() => b)
    }
    b.single = vi.fn(() => Promise.resolve(value))
    b.maybeSingle = vi.fn(() => Promise.resolve(value))
    return b
  }

  return { from: vi.fn(from) }
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
  return new Request('http://localhost/api/whatsapp/group-broadcasts/bc-1/pause', {
    method: 'POST',
  })
}

function params(id = 'bc-1') {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/whatsapp/group-broadcasts/[id]/pause', () => {
  it('404s when the campaign is not found (or not owned)', async () => {
    ctx({ whatsapp_group_broadcasts: [{ data: null, error: null }] })
    const res = await POST(request(), params())
    expect(res.status).toBe(404)
  })

  it.each(['sent', 'failed', 'cancelled', 'paused'])(
    'rejects pausing a campaign that is already %s',
    async (status) => {
      ctx({ whatsapp_group_broadcasts: [{ data: { id: 'bc-1', status }, error: null }] })
      const res = await POST(request(), params())
      expect(res.status).toBe(400)
    },
  )

  it.each(['pending', 'sending'])('pauses a %s campaign', async (status) => {
    const supabase = ctx({
      whatsapp_group_broadcasts: [
        { data: { id: 'bc-1', status }, error: null },
        { data: { id: 'bc-1', status: 'paused' }, error: null },
      ],
    })
    const res = await POST(request(), params())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.status).toBe('paused')
    expect(supabase.from).toHaveBeenCalledWith('whatsapp_group_broadcasts')
  })
})
