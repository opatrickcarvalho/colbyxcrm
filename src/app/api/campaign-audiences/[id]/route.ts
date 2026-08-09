import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveTargets, TargetValidationError, type RawTargets } from '@/lib/campaigns/targets'

// GET one audience + its members (for the audience detail/edit screen).
// PATCH renames it and/or replaces its member set wholesale — an
// audience has no per-member edit UI, so a targets update is always a
// full replace, same shape as the create body. DELETE removes it
// (campaign_audience_members cascades; whatsapp_group_broadcasts.
// audience_id is ON DELETE SET NULL, so past campaigns are untouched).

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase } = await requireRole('agent')
    const { id } = await params

    const { data: audience, error } = await supabase
      .from('campaign_audiences')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!audience) return NextResponse.json({ error: 'Audience not found' }, { status: 404 })

    const { data: members, error: membersError } = await supabase
      .from('campaign_audience_members')
      .select('*, group:whatsapp_groups(id, name), contact:contacts(id, name, phone)')
      .eq('audience_id', id)
      .order('created_at', { ascending: true })
    if (membersError) {
      return NextResponse.json({ error: membersError.message }, { status: 500 })
    }

    return NextResponse.json({ audience: { ...audience, members: members ?? [] } })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  // RLS-scoped existence check up front: the writes below go through
  // the service-role client (no RLS), so ownership has to be verified
  // here the same way quick-replies/campaign-templates enforce it with
  // an explicit .eq('account_id', ...) on every admin-client write.
  const { data: existing, error: existingError } = await ctx.supabase
    .from('campaign_audiences')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Audience not found' }, { status: 404 })
  }

  const admin = supabaseAdmin()

  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    const { error } = await admin
      .from('campaign_audiences')
      .update({ name })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if ('targets' in body) {
    const targetsInput = (body.targets ?? {}) as RawTargets
    const rawTargets: RawTargets = {
      group_ids: Array.isArray(targetsInput.group_ids) ? targetsInput.group_ids : [],
      contact_ids: Array.isArray(targetsInput.contact_ids) ? targetsInput.contact_ids : [],
      phones: Array.isArray(targetsInput.phones) ? targetsInput.phones : [],
    }

    let resolved
    try {
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

    const { error: deleteError } = await admin
      .from('campaign_audience_members')
      .delete()
      .eq('audience_id', id)
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

    const memberRows = [
      ...resolved.groupIds.map((groupId) => ({ audience_id: id, group_id: groupId })),
      ...resolved.contacts.map((c) => ({ audience_id: id, contact_id: c.id })),
      ...resolved.phones.map((phone) => ({ audience_id: id, phone })),
    ]
    const { error: insertError } = await admin
      .from('campaign_audience_members')
      .insert(memberRows)
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await supabaseAdmin()
    .from('campaign_audiences')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
