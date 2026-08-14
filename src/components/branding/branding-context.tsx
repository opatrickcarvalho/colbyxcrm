'use client';

import { createContext, useContext, type ReactNode } from 'react';

export interface BrandingValue {
  siteName: string | null;
  logoUrl: string | null;
}

const BrandingContext = createContext<BrandingValue>({
  siteName: null,
  logoUrl: null,
});

/**
 * Wraps a subtree with the platform's branding, fetched once
 * server-side (see src/lib/branding/get-branding.ts) by the layout
 * that renders it — avoids a client fetch + flash of the default
 * name/icon before the real value loads.
 */
export function BrandingProvider({
  value,
  children,
}: {
  value: BrandingValue;
  children: ReactNode;
}) {
  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): BrandingValue {
  return useContext(BrandingContext);
}
