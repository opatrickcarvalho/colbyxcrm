import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the cron drain's new contact_id / phone branches (052_campaigns
// extended targets from "always a group" to group | contact | phone) and
// the window re-check guard. The group branch itself is untouched by this
// change (per the brief) and isn't re-tested here — these cover only what's
// new. Queue-based Supabase mock: each `.from(table)` call consumes the next
// canned response for that table, in the exact order the route issues them.
// ---------------------------------------------------------------------------

function makeAdmin(responses: Record<string, unknown[]>) {
  const counters: Record<string, number> = {}
  const calls: Record<string, Array<{ args: Record<string, unknown[]> }>> = {}
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []

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
    for (const m of ['select', 'eq', 'lte', 'in', 'order', 'limit', 'update', 'delete', 'insert']) {
      b[m] = vi.fn(track(m))
    }
    b.single = vi.fn(() => Promise.resolve(value))
    b.maybeSingle = vi.fn(() => Promise.resolve(value))
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject)
    return b
  }

  return {
    from: vi.fn(from),
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    }),
    calls,
    rpcCalls,
  }
}

const mocks = vi.hoisted(() => ({
  resolveConversationByPhone: vi.fn(),
  sendMessageToConversation: vi.fn(),
}))

let admin: ReturnType<typeof makeAdmin>

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => admin,
}))

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mocks.resolveConversationByPhone,
}))

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: mocks.sendMessageToConversation,
  SendMessageError: class SendMessageError extends Error {
    code: string
    status: number
    constructor(code: string, message: string, status: number) {
      super(message)
      this.code = code
      this.status = status
    }
  },
}))

import { GET } from './route'

function req() {
  return new Request('http://localhost/api/whatsapp/group-broadcasts/cron', {
    headers: { 'x-cron-secret': 'test-secret' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/whatsapp/group-broadcasts/cron — contact_id branch', () => {
  it('resolves the conversation and sends via sendMessageToConversation, preferring rendered_text', async () => {
    const dueRow = {
      id: 't1',
      broadcast_id: 'bc-1',
      group_id: null,
      contact_id: 'c1',
      phone: null,
      rendered_text: 'Oi Ada!',
      send_at: new Date().toISOString(),
      status: 'pending',
    }
    admin = makeAdmin({
      whatsapp_group_broadcast_targets: [
        { data: [dueRow], error: null }, // due select
        { data: { id: 't1' }, error: null }, // claim
        { error: null }, // sent update
        { count: 0, error: null }, // close-out: nothing left pending/processing
      ],
      whatsapp_group_broadcasts: [
        {
          data: {
            account_id: 'acc-1',
            content_type: 'text',
            content_text: 'Oi {{primeiro_nome}}!',
            media_url: null,
            filename: null,
            window_start: null,
            window_end: null,
            window_days: null,
            timezone: 'America/Sao_Paulo',
          },
          error: null,
        }, // broadcast fetch — now BEFORE the claim, so a closed window
        // can be detected without stranding a row in 'processing'
        { error: null }, // flip to 'sending'
        { data: { sent_count: 1 }, error: null }, // close-out sent_count
        { error: null }, // close-out final status
      ],
      contacts: [{ data: { phone: '+15551110000', name: 'Bob' }, error: null }],
    })

    mocks.resolveConversationByPhone.mockResolvedValue({
      conversationId: 'conv-1',
      contactId: 'c1',
      contactCreated: false,
      avatarUrl: null,
    })
    mocks.sendMessageToConversation.mockResolvedValue({
      messageId: 'm1',
      whatsappMessageId: 'wamid-1',
    })

    const res = await GET(req())
    const json = await res.json()

    expect(json).toEqual({ processed: 1, failed: 0 })
    expect(mocks.resolveConversationByPhone).toHaveBeenCalledWith(
      admin,
      'acc-1',
      '+15551110000',
      'Bob',
    )
    expect(mocks.sendMessageToConversation).toHaveBeenCalledWith(admin, 'acc-1', {
      conversationId: 'conv-1',
      messageType: 'text',
      contentText: 'Oi Ada!', // the target's own rendered_text wins
      mediaUrl: null,
      filename: null,
    })
    expect(admin.rpcCalls).toContainEqual({
      name: 'bump_whatsapp_group_broadcast_counters',
      args: { p_broadcast_id: 'bc-1', p_success: true },
    })

    const sentUpdate = admin.calls['whatsapp_group_broadcast_targets'][2].args.update[0] as Record<
      string,
      unknown
    >
    expect(sentUpdate).toMatchObject({ status: 'sent', provider_message_id: 'wamid-1' })
  })
})

describe('GET /api/whatsapp/group-broadcasts/cron — phone branch', () => {
  it('resolves/creates the conversation directly from the raw phone, falling back to campaign content_text', async () => {
    const dueRow = {
      id: 't2',
      broadcast_id: 'bc-2',
      group_id: null,
      contact_id: null,
      phone: '+15559998888',
      rendered_text: null, // spintax was disabled for this campaign
      send_at: new Date().toISOString(),
      status: 'pending',
    }
    admin = makeAdmin({
      whatsapp_group_broadcast_targets: [
        { data: [dueRow], error: null },
        { data: { id: 't2' }, error: null },
        { error: null },
        { count: 0, error: null },
      ],
      whatsapp_group_broadcasts: [
        {
          data: {
            account_id: 'acc-2',
            content_type: 'text',
            content_text: 'Fallback message',
            media_url: null,
            filename: null,
            window_start: null,
            window_end: null,
            window_days: null,
            timezone: 'America/Sao_Paulo',
          },
          error: null,
        }, // broadcast fetch
        { error: null }, // flip to 'sending'
        { data: { sent_count: 1 }, error: null },
        { error: null },
      ],
    })

    mocks.resolveConversationByPhone.mockResolvedValue({
      conversationId: 'conv-2',
      contactId: 'c2',
      contactCreated: true,
      avatarUrl: null,
    })
    mocks.sendMessageToConversation.mockResolvedValue({
      messageId: 'm2',
      whatsappMessageId: 'wamid-2',
    })

    const res = await GET(req())
    const json = await res.json()

    expect(json).toEqual({ processed: 1, failed: 0 })
    // No contact_id on this row, so the contact table is never touched.
    expect(admin.calls['contacts']).toBeUndefined()
    expect(mocks.resolveConversationByPhone).toHaveBeenCalledWith(admin, 'acc-2', '+15559998888')
    expect(mocks.sendMessageToConversation).toHaveBeenCalledWith(admin, 'acc-2', {
      conversationId: 'conv-2',
      messageType: 'text',
      contentText: 'Fallback message',
      mediaUrl: null,
      filename: null,
    })
  })
})

describe('GET /api/whatsapp/group-broadcasts/cron — window re-check guard', () => {
  it('leaves a target untouched — never claimed, never failed — when now falls outside the campaign window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z')) // a Monday, UTC

    const dueRow = {
      id: 't3',
      broadcast_id: 'bc-3',
      group_id: null,
      contact_id: 'c3',
      phone: null,
      rendered_text: 'Hi!',
      send_at: '2026-08-10T12:00:00.000Z',
      status: 'pending',
    }
    admin = makeAdmin({
      // Only the due-select is ever issued: the guard runs before the
      // claim, so nothing else touches this table.
      whatsapp_group_broadcast_targets: [{ data: [dueRow], error: null }],
      whatsapp_group_broadcasts: [
        {
          data: {
            account_id: 'acc-3',
            content_type: 'text',
            content_text: 'Hi!',
            media_url: null,
            filename: null,
            // DB TIME columns round-trip with seconds ('HH:MM:SS').
            window_start: '08:00:00',
            window_end: '18:00:00',
            window_days: [2, 3, 4, 5, 6, 7], // every day EXCEPT Monday
            timezone: 'UTC',
          },
          error: null,
        },
      ],
    })

    const res = await GET(req())
    const json = await res.json()

    expect(json).toEqual({ processed: 0, failed: 0 })
    expect(mocks.resolveConversationByPhone).not.toHaveBeenCalled()
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled()
    expect(admin.rpcCalls).toHaveLength(0) // neither success nor failure counted

    // The due-select is the ONLY query against this table. Checking the
    // window before claiming is what keeps it that way: an aborted claim
    // would otherwise leave the row in 'processing', which the drain
    // query never selects again.
    expect(admin.calls['whatsapp_group_broadcast_targets']).toHaveLength(1)
  })
})
