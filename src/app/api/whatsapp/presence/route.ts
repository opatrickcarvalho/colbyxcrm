import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { createProvider } from '@/lib/whatsapp/providers';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const VALID_PRESENCE = new Set(['composing', 'recording', 'paused']);

/**
 * POST /api/whatsapp/presence
 *
 * Body: { conversation_id: <uuid>, presence: 'composing' | 'recording' | 'paused' }
 *
 * Best-effort "typing…" / "recording audio…" indicator on the
 * recipient's end. UAZAPI-only — Meta's Cloud API has no equivalent
 * for a business number. The composer is expected to skip calling this
 * route entirely when `capabilities.presence` is false, but this route
 * still 400s defensively rather than trusting that client-side gate.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`presence:${userId}`, RATE_LIMITS.presence);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { conversation_id, presence } = body as {
      conversation_id?: string;
      presence?: string;
    };

    if (
      !conversation_id ||
      !presence ||
      !VALID_PRESENCE.has(presence)
    ) {
      return NextResponse.json(
        {
          error:
            'conversation_id and presence ("composing" | "recording" | "paused") are required',
        },
        { status: 400 }
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, contact:contacts(phone)')
      .eq('id', conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      );
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      // `*` rather than a narrow list — same reasoning as /react: the
      // provider discriminator and per-backend credential columns all
      // have to reach the factory.
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 }
      );
    }

    let provider;
    try {
      provider = createProvider(config);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'WhatsApp not configured.';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (!provider.capabilities.presence) {
      return NextResponse.json(
        {
          error: `The "${provider.id}" provider does not support presence.`,
        },
        { status: 400 }
      );
    }

    try {
      await provider.sendPresence({
        to: sanitizePhoneForMeta(contact.phone),
        presence: presence as 'composing' | 'recording' | 'paused',
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown provider error';
      console.error('[whatsapp/presence] send failed:', message);
      return NextResponse.json(
        { error: `Provider error: ${message}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp presence POST:', error);
    return toErrorResponse(error);
  }
}
