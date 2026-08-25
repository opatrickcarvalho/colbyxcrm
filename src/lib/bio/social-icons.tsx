// ============================================================
// Social-platform badges for bio-page links.
//
// lucide-react dropped brand/logo icons a while back (Instagram,
// Facebook, Youtube, Twitter, Linkedin are all absent from the
// package). Instagram and Twitter/X are drawn from simple primitives
// (rounded-square+circle+dot, crossing lines) that read clearly as
// those two marks without reproducing exact brand bezier paths; the
// rest use the closest lucide analogue or a plain text glyph on a
// brand-colored circle.
// ============================================================

import { Mail, Music2, Phone, Play, Send } from 'lucide-react';
import type { SocialPlatform } from './link-types';

function InstagramGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth={1.8}
      className="size-4"
    >
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="0.9" fill="white" stroke="none" />
    </svg>
  );
}

function XGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      stroke="white"
      strokeWidth={2}
      strokeLinecap="round"
      className="size-3.5"
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

const PLATFORM_STYLE: Record<
  SocialPlatform,
  { bg: string; content: React.ReactNode }
> = {
  instagram: { bg: '#E1306C', content: <InstagramGlyph /> },
  tiktok: { bg: '#111111', content: <Music2 className="size-4" /> },
  facebook: {
    bg: '#1877F2',
    content: <span className="text-sm font-bold">f</span>,
  },
  youtube: {
    bg: '#FF0000',
    content: <Play className="size-3.5 fill-current" />,
  },
  twitter: { bg: '#000000', content: <XGlyph /> },
  linkedin: {
    bg: '#0A66C2',
    content: <span className="text-[10px] font-bold">in</span>,
  },
  telegram: { bg: '#26A5E4', content: <Send className="size-4" /> },
  email: { bg: '#6B7280', content: <Mail className="size-4" /> },
  phone: { bg: '#16A34A', content: <Phone className="size-4" /> },
};

export function SocialIcon({ platform }: { platform: SocialPlatform }) {
  const style = PLATFORM_STYLE[platform];
  return (
    <span
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white"
      style={{ backgroundColor: style.bg }}
    >
      {style.content}
    </span>
  );
}
