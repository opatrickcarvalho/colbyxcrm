// ============================================================
// Provider capability constants, split out from `meta.ts` /
// `uazapi.ts` so they can be imported from client components.
//
// Both adapter files pull in server-only code (uazapi.ts reads
// `process.env.UAZAPI_ADMIN_TOKEN` at module scope; meta.ts's
// `meta-api` dependency assumes a server runtime too), so importing
// either one from a "use client" component would either bundle
// secrets-adjacent code into the client or fail to resolve env vars
// that are never inlined for the browser. This file has no
// dependency beyond `./types` and is safe to import from anywhere.
//
// `meta.ts`/`uazapi.ts` re-export these same objects so every
// existing importer (`providers/index.ts`, the adapters themselves)
// keeps working unchanged — this is a relocation, not a behavior
// change.
// ============================================================

import type { ProviderCapabilities, ProviderId } from './types';

export type { ProviderCapabilities };

export const META_CAPABILITIES: ProviderCapabilities = {
  templates: true,
  interactive: true,
  reactions: true,
  session24h: true,
  inboundMediaNeedsFetch: true,
  presence: false,
  groups: false,
  labels: false,
};

export const UAZAPI_CAPABILITIES: ProviderCapabilities = {
  templates: false,
  interactive: true,
  reactions: true,
  session24h: false,
  // /message/download resolves the bytes from the message id directly,
  // so there is no separate media-id indirection to proxy.
  inboundMediaNeedsFetch: false,
  presence: true,
  groups: true,
  labels: true,
};

/** Look up a provider's capabilities by id without building a full adapter. */
export function getCapabilities(id: ProviderId): ProviderCapabilities {
  return id === 'meta' ? META_CAPABILITIES : UAZAPI_CAPABILITIES;
}
