import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// Tests for the extended POST /api/whatsapp/group-broadcasts body: mixed
// group/contact/phone targets, spintax rendering, and the new response
// shape ({ id, total_targets, first_send_at, last_send_at }). Uses a
// queue-based Supabase mock — each `.from(table)` call consumes the next
// canned response for that table, in the exact order the route issues
// them, since that order is what the route under test actually produces.
// ---------------------------------------------------------------------------

function makeSupabase(responses: Record<string, unknown[]>) {
  const counters: Record<string, number> = {}
  const calls: Record<string, Array<{ args: Record<string, unknown[]> }>> = {}

  function from(table: string) {
    const idx = counters[table] ?? 0
    counters[table] = idx + 1
    const queue = responses[table] ?? []
    const value = queue[idx] ?? queue[queue.length - 1] ?? { data: null, error: null }

    const record: { args: Record<string, unknown[]> } = { args: {} }
    calls[table] = calls[table] ?? []
    calls[table].push(record)

    const b: Record<string, unknown> = {}
    const track =
      (method: string) =>
      (...args: unknown[]) => {
        record.args[method] = args
        return b
      }
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete', 'insert']) {
      b[m] = vi.fn(track(m))
    }
    b.single = vi.fn(() => Promise.resolve(value))
    b.maybeSingle = vi.fn(() => Promise.resolve(value))
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject)
    return b
  }

  return { from: vi.fn(from), calls }
}

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveGroupCredentials: vi.fn(async () => ({ host: 'h', token: 't', configId: 'cfg-1' })),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))

vi.mock('@/lib/whatsapp/providers/uazapi-groups', () => ({
  resolveGroupCredentials: mocks.resolveGroupCredentials,
  GroupsNotAvailableError: class GroupsNotAvailableError extends Error {},
}))

import { POST } from './route'

let supabase: ReturnType<typeof makeSupabase>

function request(body: unknown) {
  return new Request('http://localhost/api/whatsapp/group-broadcasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function ctx(responses: Record<string, unknown[]>) {
  supabase = makeSupabase(responses)
  mocks.requireRole.mockResolvedValue({ supabase, accountId: 'acc-1', userId: 'user-1' })
}

beforeEach(() => {
  __resetRateLimitForTests()
  vi.clearAllMocks()
  mocks.resolveGroupCredentials.mockResolvedValue({ host: 'h', token: 't', configId: 'cfg-1' })
})

describe('POST /api/whatsapp/group-broadcasts — body validation', () => {
  it('rejects a missing name', async () => {
    ctx({})
    const res = await POST(
      request({ content_type: 'text', content_text: 'hi', delay_seconds: 30 }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects an unknown content_type', async () => {
    ctx({})
    const res = await POST(
      request({ name: 'Promo', content_type: 'sticker', delay_seconds: 30 }),
    )
    expect(res.status).toBe(400)
  })

  it('404-shapes as 400 when a target group is not owned by the account', async () => {
    ctx({ whatsapp_groups: [{ data: [], error: null }] })
    const res = await POST(
      request({
        name: 'Promo',
        content_type: 'text',
        content_text: 'hi',
        delay_seconds: 30,
        targets: { group_ids: ['g1'] },
      }),
    )
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/Groups not found/)
  })

  it('rejects a request with no targets at all', async () => {
    ctx({})
    const res = await POST(
      request({ name: 'Promo', content_type: 'text', content_text: 'hi', delay_seconds: 30 }),
    )
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/At least one target/)
  })

  it('rejects unbalanced spintax before scheduling anything', async () => {
    ctx({})
    const res = await POST(
      request({
        name: 'Promo',
        content_type: 'text',
        content_text: '{unbalanced',
        delay_seconds: 30,
        targets: { phones: ['+15551234567'] },
      }),
    )
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/Invalid spintax template/)
  })

  it('rejects a malformed window', async () => {
    ctx({})
    const res = await POST(
      request({
        name: 'Promo',
        content_type: 'text',
        content_text: 'hi',
        delay_seconds: 30,
        targets: { phones: ['+15551234567'] },
        window: { start: '08:00', end: '18:00' }, // missing `days`
      }),
    )
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/window\.days/)
  })
})

describe('POST /api/whatsapp/group-broadcasts — happy path', () => {
  it('dedupes a hand-typed phone against a targeted contact, renders spintax per recipient, and returns the new response shape', async () => {
    ctx({
      whatsapp_groups: [{ data: [{ id: 'g1', status: 'active' }], error: null }],
      contacts: [
        {
          data: [{ id: 'c1', name: 'Ada Lovelace', phone: '+15551234567' }],
          error: null,
        },
      ],
      whatsapp_group_broadcasts: [
        {
          data: { id: 'bc-1', account_id: 'acc-1', total_targets: 2 },
          error: null,
        },
      ],
      whatsapp_group_broadcast_targets: [{ data: null, error: null }],
    })

    const res = await POST(
      request({
        name: 'Promo',
        content_type: 'text',
        content_text: 'Oi {{primeiro_nome}}!',
        delay_seconds: 30,
        targets: {
          group_ids: ['g1'],
          contact_ids: ['c1'],
          // Same person as contact c1 — must not become a second target.
          phones: ['+1 (555) 123-4567'],
        },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toMatchObject({ id: 'bc-1', total_targets: 2 })
    expect(json.first_send_at).toBeTruthy()
    expect(json.last_send_at).toBeTruthy()

    // Campaign row picked up the documented defaults.
    const broadcastInsert = supabase.calls['whatsapp_group_broadcasts'][0].args.insert[0] as Record<
      string,
      unknown
    >
    expect(broadcastInsert).toMatchObject({
      delay_jitter_pct: 20,
      timezone: 'America/Sao_Paulo',
      spintax_enabled: true,
      invisible_chars: false,
      total_targets: 2,
      audience_id: null,
    })

    // Exactly 2 target rows — the deduped phone never became a 3rd.
    const targetRows = supabase.calls['whatsapp_group_broadcast_targets'][0].args.insert[0] as Array<
      Record<string, unknown>
    >
    expect(targetRows).toHaveLength(2)

    const groupRow = targetRows.find((r) => r.group_id === 'g1')!
    const contactRow = targetRows.find((r) => r.contact_id === 'c1')!
    expect(groupRow.rendered_text).toBe('Oi !') // empty vars for a group target
    expect(contactRow.rendered_text).toBe('Oi Ada!') // {{primeiro_nome}} resolved
    expect(targetRows.every((r) => r.phone == null)).toBe(true)
  })
})
