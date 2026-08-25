// ============================================================
// Social-platform badges for bio-page links.
//
// lucide-react dropped brand/logo icons a while back (Instagram,
// Facebook, Youtube, Twitter, Linkedin are all absent from the
// package) — rather than pull in a second icon library for a handful
// of glyphs, each platform gets a small colored circle with either a
// close lucide analogue or a plain text glyph inside.
// ============================================================

import { Camera, Mail, Music2, Phone, Play, Send } from 'lucide-react';
import type { SocialPlatform } from './link-types';

const PLATFORM_STYLE: Record<
  SocialPlatform,
  { bg: string; content: React.ReactNode }
> = {
  instagram: { bg: '#E1306C', content: <Camera className="size-4" /> },
  tiktok: { bg: '#111111', content: <Music2 className="size-4" /> },
  facebook: { bg: '#1877F2', content: <span className="text-xs font-bold">f</span> },
  youtube: { bg: '#FF0000', content: <Play className="size-3.5 fill-current" /> },
  twitter: { bg: '#000000', content: <span className="text-xs font-bold">X</span> },
  linkedin: { bg: '#0A66C2', content: <span className="text-[10px] font-bold">in</span> },
  telegram: { bg: '#26A5E4', content: <Send className="size-4" /> },
  email: { bg: '#6B7280', content: <Mail className="size-4" /> },
  phone: { bg: '#16A34A', content: <Phone className="size-4" /> },
};

export function SocialIcon({ platform }: { platform: SocialPlatform }) {
  const style = PLATFORM_STYLE[platform];
  return (
    <span
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white"
      style={{ backgroundColor: style.bg }}
    >
      {style.content}
    </span>
  );
}
