import { describe, it, expect, vi } from 'vitest'

function makeSupabase(responses: Record<string, unknown[]>) {
  const counters: Record<string, number> = {}
  // Per-table, per-method list of every call's args — a chain can call
  // `.eq()` more than once (broadcast_id, then status), so this
  // accumulates rather than overwriting like the sibling route tests'
  // simpler single-`.eq()`-per-chain mock does.
  const calls: Record<string, Array<{ args: Record<string, unknown[][]> }>> = {}

  function from(table: string) {
    const idx = counters[table] ?? 0
    counters[table] = idx + 1
    const queue = responses[table] ?? []
    const value = queue[idx] ?? queue[queue.length - 1] ?? { data: null, error: null }

    const record: { args: Record<string, unknown[][]> } = { args: {} }
    calls[table] = calls[table] ?? []
    calls[table].push(record)

    const b: Record<string, unknown> = {}
    const track =
      (method: string) =>
      (...args: unknown[]) => {
        record.args[method] = record.args[method] ?? []
        record.args[method].push(args)
        return b
      }
    for (const m of ['select', 'eq', 'in', 'update']) {
      b[m] = vi.fn(track(m))
    }
    b.maybeSingle = vi.fn(() => Promise.resolve(value))
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject)
    return b
  }

  return { from: vi.fn(from), calls }
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

function request(body: unknown) {
  return new Request('http://localhost/api/whatsapp/group-broadcasts/bc-1/targets/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function params(id = 'bc-1') {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/whatsapp/group-broadcasts/[id]/targets/remove', () => {
  it('rejects an empty/missing target_ids', async () => {
    ctx({})
    const res = await POST(request({}), params())
    expect(res.status).toBe(400)
  })

  it('404s when the campaign is not found (or not owned)', async () => {
    ctx({ whatsapp_group_broadcasts: [{ data: null, error: null }] })
    const res = await POST(request({ target_ids: ['t1'] }), params())
    expect(res.status).toBe(404)
  })

  it('cancels only the requested, still-pending targets and reports the count', async () => {
    const supabase = ctx({
      whatsapp_group_broadcasts: [{ data: { id: 'bc-1' }, error: null }],
      whatsapp_group_broadcast_targets: [
        { data: [{ id: 't1' }, { id: 't2' }], error: null },
      ],
    })

    const res = await POST(request({ target_ids: ['t1', 't2', 't3'] }), params())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.removed).toBe(2)

    const updateCall = supabase.calls['whatsapp_group_broadcast_targets'][0]
    expect(updateCall.args.update[0]).toEqual([{ status: 'cancelled' }])
    // Scoped to this campaign, only 'pending' rows, only the requested ids
    // — a sent/failed/processing row must never be touched by this route.
    expect(updateCall.args.eq).toContainEqual(['broadcast_id', 'bc-1'])
    expect(updateCall.args.eq).toContainEqual(['status', 'pending'])
    expect(updateCall.args.in[0]).toEqual(['id', ['t1', 't2', 't3']])
  })
})
