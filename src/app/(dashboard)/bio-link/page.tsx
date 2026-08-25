'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Copy,
  GripVertical,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  BIO_LINK_TYPE_LABELS,
  BIO_LINK_TYPES,
  SOCIAL_PLATFORMS,
  type BioLinkType,
} from '@/lib/bio/link-types';
import { BioPagePreview } from '@/components/bio/bio-page-preview';
import {
  DEFAULT_BUTTON_COLOR,
  DEFAULT_TEXT_COLOR,
  isHexColor,
} from '@/lib/bio/theme';

// Client-side mirror of slugifyCampaignCode — see
// src/app/(dashboard)/ad-links/new/page.tsx for why this isn't
// imported (node:crypto in the same module can't resolve client-side).
function previewSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 30);
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

interface BioPage {
  id: string;
  slug: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  active: boolean;
  view_count: number;
  button_color: string;
  text_color: string;
}

interface BioPageLink {
  id: string;
  type: BioLinkType;
  label: string;
  url: string | null;
  ad_campaign_id: string | null;
  icon: string | null;
  active: boolean;
  click_count: number;
}

interface AdCampaign {
  id: string;
  name: string;
  active: boolean;
}

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success('Link copiado');
}

export default function BioLinkPage() {
  const { accountId } = useAuth();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<BioPage | null>(null);
  const [links, setLinks] = useState<BioPageLink[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);

  // Create form (shown when no page exists yet).
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newSlugTouched, setNewSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);

  // Settings form (mirrors `page` once it exists).
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [bio, setBio] = useState('');
  const [active, setActive] = useState(true);
  const [buttonColor, setButtonColor] = useState(DEFAULT_BUTTON_COLOR);
  const [textColor, setTextColor] = useState(DEFAULT_TEXT_COLOR);
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Add/edit link dialog.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<BioPageLink | null>(null);
  const [linkType, setLinkType] = useState<BioLinkType>('link');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkCampaignId, setLinkCampaignId] = useState('');
  const [linkIcon, setLinkIcon] = useState('');
  const [savingLink, setSavingLink] = useState(false);

  async function loadAll() {
    setLoading(true);
    try {
      const [pageRes, linksRes, campaignsRes] = await Promise.all([
        fetch('/api/bio-page', { cache: 'no-store' }),
        fetch('/api/bio-page/links', { cache: 'no-store' }),
        fetch('/api/ad-campaigns', { cache: 'no-store' }),
      ]);
      const pageData = await pageRes.json().catch(() => ({}));
      const linksData = await linksRes.json().catch(() => ({}));
      const campaignsData = await campaignsRes.json().catch(() => ({}));
      if (!pageRes.ok)
        throw new Error(pageData.error ?? 'Falha ao carregar página');

      setPage(pageData.data ?? null);
      setLinks(linksData.data ?? []);
      setCampaigns(campaignsData.data ?? []);

      if (pageData.data) {
        setDisplayName(pageData.data.display_name);
        setSlug(pageData.data.slug);
        setBio(pageData.data.bio ?? '');
        setActive(pageData.data.active);
        setButtonColor(pageData.data.button_color ?? DEFAULT_BUTTON_COLOR);
        setTextColor(pageData.data.text_color ?? DEFAULT_TEXT_COLOR);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Falha ao carregar página'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // Only on mount — subsequent updates go through local state + the
    // specific handlers below, not a full reload.
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handleCreate() {
    if (!newDisplayName.trim()) {
      toast.error('Dê um nome para a página');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/bio-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: newDisplayName,
          slug: newSlugTouched ? newSlug : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Falha ao criar página');
      toast.success('Página criada');
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao criar página');
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveSettings() {
    if (!displayName.trim()) {
      toast.error('O nome não pode ficar vazio');
      return;
    }
    if (!previewSlug(slug)) {
      toast.error('O endereço precisa ter pelo menos uma letra, número ou _');
      return;
    }
    setSavingSettings(true);
    try {
      let avatarUrl = page?.avatar_url ?? null;
      if (pendingAvatar && accountId) {
        const ext = pendingAvatar.name.split('.').pop()?.toLowerCase() || 'png';
        const path = `${accountId}/avatar-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('bio-page-media')
          .upload(path, pendingAvatar, {
            cacheControl: '3600',
            upsert: true,
            contentType: pendingAvatar.type,
          });
        if (uploadError)
          throw new Error(`Falha no upload: ${uploadError.message}`);
        const {
          data: { publicUrl },
        } = supabase.storage.from('bio-page-media').getPublicUrl(path);
        avatarUrl = publicUrl;
      }

      const res = await fetch('/api/bio-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          slug,
          bio: bio.trim() || null,
          avatar_url: avatarUrl,
          active,
          button_color: buttonColor,
          text_color: textColor,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Falha ao salvar');
      setPage(data.data);
      setPendingAvatar(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      toast.success('Página atualizada');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar');
    } finally {
      setSavingSettings(false);
    }
  }

  function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_MIME.has(file.type)) {
      toast.error('Formato de imagem não suportado');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error('Imagem muito grande (máx. 2MB)');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function openAddDialog() {
    setEditingLink(null);
    setLinkType('link');
    setLinkLabel('');
    setLinkUrl('');
    setLinkCampaignId('');
    setLinkIcon('');
    setDialogOpen(true);
  }

  function openEditDialog(link: BioPageLink) {
    setEditingLink(link);
    setLinkType(link.type);
    setLinkLabel(link.label);
    setLinkUrl(link.url ?? '');
    setLinkCampaignId(link.ad_campaign_id ?? '');
    setLinkIcon(link.icon ?? '');
    setDialogOpen(true);
  }

  async function handleSaveLink() {
    if (!linkLabel.trim()) {
      toast.error('Dê um nome para o botão');
      return;
    }
    if (linkType === 'whatsapp' && !linkCampaignId) {
      toast.error('Escolha uma campanha de WhatsApp');
      return;
    }
    if (linkType !== 'whatsapp' && !linkUrl.trim()) {
      toast.error('Informe a URL');
      return;
    }
    setSavingLink(true);
    try {
      const body = {
        type: linkType,
        label: linkLabel,
        url: linkType === 'whatsapp' ? undefined : linkUrl,
        ad_campaign_id: linkType === 'whatsapp' ? linkCampaignId : undefined,
        icon: linkIcon || undefined,
      };
      const res = await fetch(
        editingLink
          ? `/api/bio-page/links/${editingLink.id}`
          : '/api/bio-page/links',
        {
          method: editingLink ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Falha ao salvar botão');
      setDialogOpen(false);
      await loadAll();
      toast.success(editingLink ? 'Botão atualizado' : 'Botão adicionado');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar botão');
    } finally {
      setSavingLink(false);
    }
  }

  async function handleToggleActive(link: BioPageLink, value: boolean) {
    setLinks((prev) =>
      prev.map((l) => (l.id === link.id ? { ...l, active: value } : l))
    );
    const res = await fetch(`/api/bio-page/links/${link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: value }),
    });
    if (!res.ok) {
      setLinks((prev) =>
        prev.map((l) => (l.id === link.id ? { ...l, active: !value } : l))
      );
      toast.error('Falha ao atualizar botão');
    }
  }

  async function handleDeleteLink(link: BioPageLink) {
    if (!confirm(`Excluir o botão "${link.label}"?`)) return;
    const res = await fetch(`/api/bio-page/links/${link.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      toast.error('Falha ao excluir botão');
      return;
    }
    setLinks((prev) => prev.filter((l) => l.id !== link.id));
    toast.success('Botão excluído');
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  function handleReorder(event: DragEndEvent) {
    const { active: activeItem, over } = event;
    if (!over || activeItem.id === over.id) return;
    const oldIndex = links.findIndex((l) => l.id === activeItem.id);
    const newIndex = links.findIndex((l) => l.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(links, oldIndex, newIndex);
    setLinks(reordered);
    void fetch('/api/bio-page/links/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        positions: reordered.map((l, i) => ({ id: l.id, position: i })),
      }),
    }).catch(() => toast.error('Falha ao salvar a ordem'));
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!page) {
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <div>
          <h1 className="text-foreground text-2xl font-bold">
            Sua página de links
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Crie uma página pública com seus botões — como um Linktree, com cada
            clique medido.
          </p>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              <Label htmlFor="new-name">Nome exibido</Label>
              <Input
                id="new-name"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="Ex: Ótica Vista Bela"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-slug">Endereço da página</Label>
              <Input
                id="new-slug"
                value={newSlugTouched ? newSlug : previewSlug(newDisplayName)}
                onChange={(e) => {
                  setNewSlugTouched(true);
                  setNewSlug(previewSlug(e.target.value));
                }}
                className="font-mono"
                placeholder="Ex: oticavistabela"
              />
              <p className="text-muted-foreground text-xs">
                Sua página ficará em{' '}
                <span className="font-mono">
                  /b/
                  {(newSlugTouched ? newSlug : previewSlug(newDisplayName)) ||
                    'endereco'}
                </span>
              </p>
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Criar página
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const publicUrl = `${origin}/b/${slug}`;
  const currentAvatar = previewUrl ?? page.avatar_url;
  // Mirrors what the public page actually renders (it only ever
  // selects active links) so the preview doesn't show a button a
  // visitor wouldn't see.
  const previewLinks = links.filter((l) => l.active);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">
          Sua página de links
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {page.view_count} visualizaç{page.view_count === 1 ? 'ão' : 'ões'} até
          agora
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="max-w-xl space-y-6">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-center gap-4">
                <Avatar size="lg" className="size-16">
                  {currentAvatar ? (
                    <AvatarImage src={currentAvatar} alt={displayName} />
                  ) : null}
                  <AvatarFallback className="bg-primary/10 text-primary text-base">
                    {displayName.charAt(0).toUpperCase() || 'B'}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={onPickAvatar}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                    Alterar foto
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="display-name">Nome exibido</Label>
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="slug">Endereço</Label>
                <Input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(previewSlug(e.target.value))}
                  className="font-mono"
                />
                <div className="flex gap-2">
                  <Input
                    value={publicUrl}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copy(publicUrl)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  rows={2}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <ColorField
                  id="button-color"
                  label="Cor dos botões"
                  value={buttonColor}
                  onChange={setButtonColor}
                />
                <ColorField
                  id="text-color"
                  label="Cor da fonte"
                  value={textColor}
                  onChange={setTextColor}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="page-active">Página ativa</Label>
                <Switch
                  id="page-active"
                  checked={active}
                  onCheckedChange={setActive}
                />
              </div>

              <div className="flex justify-end pt-2">
                <Button onClick={handleSaveSettings} disabled={savingSettings}>
                  {savingSettings ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Salvar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="flex items-center justify-between">
                <Label>Botões</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openAddDialog}
                >
                  <Plus className="h-3 w-3" />
                  Adicionar botão
                </Button>
              </div>

              {links.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  Nenhum botão ainda — adicione o primeiro.
                </p>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleReorder}
                >
                  <SortableContext
                    items={links.map((l) => l.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {links.map((link) => (
                        <SortableLinkRow
                          key={link.id}
                          link={link}
                          campaigns={campaigns}
                          onEdit={() => openEditDialog(link)}
                          onToggleActive={(v) => handleToggleActive(link, v)}
                          onDelete={() => handleDeleteLink(link)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-6">
          <p className="text-muted-foreground mb-2 text-xs font-medium">
            Prévia da página
          </p>
          <div className="mx-auto max-h-[640px] w-full max-w-[300px] overflow-y-auto rounded-[2rem] border-8 border-neutral-800 bg-neutral-950 shadow-lg">
            <BioPagePreview
              displayName={displayName || 'Sua página'}
              bio={bio}
              avatarUrl={currentAvatar}
              links={previewLinks}
              buttonColor={buttonColor}
              textColor={textColor}
            />
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingLink ? 'Editar botão' : 'Novo botão'}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>Tipo</Label>
              <Select
                value={linkType}
                onValueChange={(v) => setLinkType(v as BioLinkType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BIO_LINK_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {BIO_LINK_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="link-label">Nome do botão</Label>
              <Input
                id="link-label"
                value={linkLabel}
                onChange={(e) => setLinkLabel(e.target.value)}
              />
            </div>

            {linkType === 'whatsapp' ? (
              <div className="grid gap-2">
                <Label>Campanha de WhatsApp</Label>
                <Select
                  value={linkCampaignId}
                  onValueChange={(v) => setLinkCampaignId(v ?? '')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Escolha uma campanha" />
                  </SelectTrigger>
                  <SelectContent>
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {campaigns.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    Crie uma campanha em Links de Anúncio primeiro.
                  </p>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="link-url">URL</Label>
                <Input
                  id="link-url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            )}

            {linkType === 'social' && (
              <div className="grid gap-2">
                <Label>Ícone</Label>
                <Select
                  value={linkIcon}
                  onValueChange={(v) => setLinkIcon(v ?? '')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Escolha a rede" />
                  </SelectTrigger>
                  <SelectContent>
                    {SOCIAL_PLATFORMS.map((platform) => (
                      <SelectItem key={platform} value={platform}>
                        {platform}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveLink} disabled={savingLink}>
              {savingLink ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  // A local text buffer separate from `value` — typing an in-progress
  // hex string ("#17") must stay on screen even though it isn't valid
  // yet, so it can't be a straight controlled input off the (already
  // validated) parent value.
  const [text, setText] = useState(value);
  // Legitimate prop-driven sync (same pattern as PipelineSettings) —
  // resyncs when `value` changes externally (e.g. page load), not on
  // every local keystroke (those go through onChange below instead).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => setText(value), [value]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          id={id}
          value={value}
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
          }}
          className="border-border h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
        />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (isHexColor(e.target.value)) onChange(e.target.value);
          }}
          maxLength={7}
          className="font-mono text-sm"
        />
      </div>
    </div>
  );
}

function SortableLinkRow({
  link,
  campaigns,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  link: BioPageLink;
  campaigns: AdCampaign[];
  onEdit: () => void;
  onToggleActive: (v: boolean) => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: link.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const subtitle =
    link.type === 'whatsapp'
      ? (campaigns.find((c) => c.id === link.ad_campaign_id)?.name ??
        'Campanha removida')
      : link.url;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border-border bg-muted flex items-center gap-2 rounded-lg border p-2"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none active:cursor-grabbing"
        aria-label="Arraste para reordenar"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 text-left"
      >
        <p className="text-foreground truncate text-sm font-medium">
          {link.label}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {BIO_LINK_TYPE_LABELS[link.type]} · {subtitle} · {link.click_count}{' '}
          cliques
        </p>
      </button>
      <Switch checked={link.active} onCheckedChange={onToggleActive} />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDelete}
        className="text-muted-foreground hover:text-red-400"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
