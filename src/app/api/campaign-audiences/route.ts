import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveTargets, TargetValidationError, type RawTargets } from '@/lib/campaigns/targets'

// Saved, reusable campaign audiences (see 052_campaigns.sql — a
// campaign snapshots its targets at creation time, so an audience is a
// reusable *recipe*, not a live link). GET lists with a member count
// per audience; POST creates the audience plus its initial member rows
// in one call. Mirrors quick-replies: RLS-scoped read via the user
// client, service-role write after an explicit role check.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data: audiences, error } = await supabase
      .from('campaign_audiences')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = audiences ?? []
    if (rows.length === 0) return NextResponse.json({ audiences: [] })

    // Counted in JS from a plain column select rather than PostgREST's
    // embedded-aggregate `(count)` syntax — one extra round trip, but
    // it keeps the shape of the response unambiguous and doesn't rely
    // on a supabase-js embedding behaviour that's easy to get subtly
    // wrong (single object vs one-element array).
    const { data: members, error: membersError } = await supabase
      .from('campaign_audience_members')
      .select('audience_id')
      .in(
        'audience_id',
        rows.map((a) => a.id as string),
      )
    if (membersError) {
      return NextResponse.json({ error: membersError.message }, { status: 500 })
    }

    const counts = new Map<string, number>()
    for (const m of members ?? []) {
      const key = m.audience_id as string
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    return NextResponse.json({
      audiences: rows.map((a) => ({
        ...a,
        member_count: counts.get(a.id as string) ?? 0,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const targetsInput = (body.targets ?? {}) as RawTargets
  const rawTargets: RawTargets = {
    group_ids: Array.isArray(targetsInput.group_ids) ? targetsInput.group_ids : [],
    contact_ids: Array.isArray(targetsInput.contact_ids) ? targetsInput.contact_ids : [],
    phones: Array.isArray(targetsInput.phones) ? targetsInput.phones : [],
  }

  let resolved
  try {
    // Validated through the caller's RLS-scoped client — same
    // "never trust client ids" gate the group-broadcasts POST route
    // uses, since this insert would otherwise happen through the
    // service-role client below, which has no RLS to fall back on.
    resolved = await resolveTargets(ctx.supabase, ctx.accountId, rawTargets)
  } catch (err) {
    if (err instanceof TargetValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const total = resolved.groupIds.length + resolved.contacts.length + resolved.phones.length
  if (total === 0) {
    return NextResponse.json(
      { error: 'At least one target (group, contact, or phone) is required' },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()
  const { data: audience, error: audienceError } = await admin
    .from('campaign_audiences')
    .insert({ account_id: ctx.accountId, user_id: ctx.userId, name })
    .select()
    .single()

  if (audienceError || !audience) {
    return NextResponse.json(
      { error: audienceError?.message ?? 'Failed to create audience' },
      { status: 500 },
    )
  }

  const memberRows = [
    ...resolved.groupIds.map((groupId) => ({ audience_id: audience.id, group_id: groupId })),
    ...resolved.contacts.map((c) => ({ audience_id: audience.id, contact_id: c.id })),
    ...resolved.phones.map((phone) => ({ audience_id: audience.id, phone })),
  ]
  const { error: memberError } = await admin
    .from('campaign_audience_members')
    .insert(memberRows)

  if (memberError) {
    // Roll back the orphan audience row rather than leaving a
    // member-less audience behind.
    await admin.from('campaign_audiences').delete().eq('id', audience.id)
    return NextResponse.json({ error: 'Failed to save audience members' }, { status: 500 })
  }

  return NextResponse.json(
    { audience: { ...audience, member_count: total } },
    { status: 201 },
  )
}
