'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

interface BrandingSettings {
  siteName: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
}

/**
 * Platform-admin control for `platform_settings`' `branding_*` keys
 * (migration 057) — site name, favicon and logo applied across the
 * whole instance. Mirrors the load/save/denied-state pattern of
 * AdminBillingSettingsPage (src/app/admin/settings/page.tsx).
 */
export default function AdminBrandingPage() {
  const t = useTranslations('Admin.branding');

  const [saved, setSaved] = useState<BrandingSettings | null>(null);
  const [siteName, setSiteName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [denied, setDenied] = useState(false);

  const [pendingIcon, setPendingIcon] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [clearIcon, setClearIcon] = useState(false);

  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [clearLogo, setClearLogo] = useState(false);

  const iconInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (iconPreview) URL.revokeObjectURL(iconPreview);
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    };
  }, [iconPreview, logoPreview]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/branding');
      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadError'));
        return;
      }
      setSaved(data.settings);
      setSiteName(data.settings.siteName ?? '');
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function onPickFile(
    kind: 'icon' | 'logo',
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t('unsupportedImage'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(t('imageTooLarge'));
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    if (kind === 'icon') {
      if (iconPreview) URL.revokeObjectURL(iconPreview);
      setPendingIcon(file);
      setIconPreview(previewUrl);
      setClearIcon(false);
    } else {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      setPendingLogo(file);
      setLogoPreview(previewUrl);
      setClearLogo(false);
    }
  }

  function onRemove(kind: 'icon' | 'logo') {
    if (kind === 'icon') {
      if (iconPreview) URL.revokeObjectURL(iconPreview);
      setPendingIcon(null);
      setIconPreview(null);
      setClearIcon(true);
    } else {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      setPendingLogo(null);
      setLogoPreview(null);
      setClearLogo(true);
    }
  }

  async function persist() {
    setSaving(true);
    try {
      const form = new FormData();
      if (saved && siteName.trim() !== (saved.siteName ?? '')) {
        form.set('siteName', siteName.trim());
      }
      if (pendingIcon) form.set('icon', pendingIcon);
      if (clearIcon) form.set('clearIcon', 'true');
      if (pendingLogo) form.set('logo', pendingLogo);
      if (clearLogo) form.set('clearLogo', 'true');

      if (![...form.keys()].length) {
        setSaving(false);
        return;
      }

      const res = await fetch('/api/admin/branding', {
        method: 'PATCH',
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('actionError'));
        return;
      }

      setSaved(data.settings);
      setSiteName(data.settings.siteName ?? '');
      if (iconPreview) URL.revokeObjectURL(iconPreview);
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      setPendingIcon(null);
      setIconPreview(null);
      setClearIcon(false);
      setPendingLogo(null);
      setLogoPreview(null);
      setClearLogo(false);
      toast.success(t('savedToast'));
    } catch {
      toast.error(t('actionError'));
    } finally {
      setSaving(false);
    }
  }

  if (denied) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-muted-foreground text-sm">{t('loadError')}</p>
      </div>
    );
  }

  if (loading || !saved) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  const currentIcon = iconPreview ?? (!clearIcon ? saved.iconUrl : null);
  const currentLogo = logoPreview ?? (!clearLogo ? saved.logoUrl : null);

  const dirty =
    siteName.trim() !== (saved.siteName ?? '') ||
    pendingIcon !== null ||
    clearIcon ||
    pendingLogo !== null ||
    clearLogo;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-foreground text-xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('fieldSiteName')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Input
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            maxLength={120}
            placeholder="wacrm"
          />
          <p className="text-muted-foreground text-xs">
            {t('fieldSiteNameHint')}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t('fieldIcon')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">{t('fieldIconHint')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="border-border bg-muted flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border">
              {currentIcon ? (
                <img
                  src={currentIcon}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : null}
            </div>
            <input
              ref={iconInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              className="hidden"
              onChange={(e) => onPickFile('icon', e)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => iconInputRef.current?.click()}
              disabled={saving}
            >
              <Upload className="h-3.5 w-3.5" />
              {t('upload')}
            </Button>
            {currentIcon && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemove('icon')}
                disabled={saving}
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('remove')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t('fieldLogo')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">{t('fieldLogoHint')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="border-border bg-muted flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border">
              {currentLogo ? (
                <img
                  src={currentLogo}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : null}
            </div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              className="hidden"
              onChange={(e) => onPickFile('logo', e)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => logoInputRef.current?.click()}
              disabled={saving}
            >
              <Upload className="h-3.5 w-3.5" />
              {t('upload')}
            </Button>
            {currentLogo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemove('logo')}
                disabled={saving}
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('remove')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 flex justify-end">
        <Button onClick={() => void persist()} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('save')}
        </Button>
      </div>
    </div>
  );
}
