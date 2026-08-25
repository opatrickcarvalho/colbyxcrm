'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, Loader2, Save, Trash2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Tag } from '@/types';

const NO_TAG = '__none__';

interface AdCampaign {
  id: string;
  name: string;
  code: string;
  message_template: string;
  active: boolean;
  tag_id: string | null;
  click_count?: number;
  conversation_count?: number;
  won_count?: number;
}

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copiado`);
}

// See src/app/(dashboard)/ad-links/new/page.tsx for why this mirrors
// slugifyCampaignCode instead of importing it.
function previewSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 30);
}

export default function AdCampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { accountId } = useAuth();
  const [campaign, setCampaign] = useState<AdCampaign | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [template, setTemplate] = useState('');
  const [active, setActive] = useState(true);
  const [tagId, setTagId] = useState(NO_TAG);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // The list endpoint already returns every campaign with its
        // counts — reusing it here avoids a second GET-by-id route for
        // one detail screen.
        const res = await fetch('/api/ad-campaigns', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Falha ao carregar campanha');
        const found = (data.data as AdCampaign[] | undefined)?.find((c) => c.id === params.id);
        if (!found) throw new Error('Campanha não encontrada');
        if (!cancelled) {
          setCampaign(found);
          setName(found.name);
          setCode(found.code);
          setTemplate(found.message_template);
          setActive(found.active);
          setTagId(found.tag_id ?? NO_TAG);
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Falha ao carregar campanha');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  useEffect(() => {
    if (!accountId) return;
    supabase
      .from('tags')
      .select('*')
      .eq('account_id', accountId)
      .order('name')
      .then(({ data }) => setTags(data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function handleSave() {
    if (!name.trim()) {
      toast.error('O nome não pode ficar vazio');
      return;
    }
    if (!previewSlug(code)) {
      toast.error('O código precisa ter pelo menos uma letra, número ou _');
      return;
    }
    if (!template.includes('{code}')) {
      toast.error('A mensagem precisa conter o placeholder {code}');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/ad-campaigns/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          code,
          message_template: template,
          active,
          tag_id: tagId === NO_TAG ? null : tagId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Falha ao salvar');
      setCampaign(data.data);
      toast.success('Campanha atualizada');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Excluir esta campanha? Isso não afeta contatos já atribuídos.')) return;
    try {
      const res = await fetch(`/api/ad-campaigns/${params.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Falha ao excluir');
      }
      toast.success('Campanha excluída');
      router.push('/ad-links');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao excluir');
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!campaign) return null;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const trackingLink = `${origin}/l/${code}`;
  const renderedMessage = template.replace('{code}', code);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{campaign.name}</h1>
        <Button variant="outline" className="text-red-400 hover:text-red-400" onClick={handleDelete}>
          <Trash2 className="h-4 w-4" />
          Excluir
        </Button>
      </div>

      <Card>
        <CardContent className="grid grid-cols-3 gap-4 pt-6 text-center">
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{campaign.click_count ?? 0}</p>
            <p className="text-xs text-muted-foreground">Cliques</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {campaign.conversation_count ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">Conversas</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{campaign.won_count ?? 0}</p>
            <p className="text-xs text-muted-foreground">Negócios ganhos</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-2">
            <Label>Link de rastreamento</Label>
            <div className="flex gap-2">
              <Input value={trackingLink} readOnly className="font-mono text-sm" />
              <Button variant="outline" onClick={() => copy(trackingLink, 'Link')}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use este link em bio, QR code, Google Ads ou qualquer lugar clicável — ele redireciona
              direto pro WhatsApp.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Texto para colar no anúncio nativo da Meta</Label>
            <div className="flex gap-2">
              <Input value={renderedMessage} readOnly className="text-sm" />
              <Button variant="outline" onClick={() => copy(renderedMessage, 'Texto')}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Cole como a &quot;mensagem pré-preenchida&quot; de um anúncio nativo &quot;Clique para o
              WhatsApp&quot; — esse tipo de anúncio vai direto pro WhatsApp, sem passar pelo link acima.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-2">
            <Label htmlFor="name">Nome</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="code">Código de rastreamento</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(previewSlug(e.target.value))}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Mudar o código atualiza o link e o texto do anúncio abaixo — cliques/mensagens que já
              chegaram usando o código antigo não são afetados, mas anúncios já publicados com o
              código antigo param de casar.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="template">Mensagem pré-preenchida (template)</Label>
            <Textarea
              id="template"
              rows={3}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tag">Etiqueta a aplicar no lead</Label>
            <Select value={tagId} onValueChange={(v) => setTagId(v ?? NO_TAG)}>
              <SelectTrigger id="tag" className="w-full">
                <SelectValue placeholder="Nenhuma" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TAG}>Nenhuma</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    {tag.name}
                    {tag.whatsapp_label_id ? ' 🔗' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Aplicada automaticamente no contato quando ele chegar por essa campanha. 🔗 = também
              sincroniza com uma etiqueta do WhatsApp.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="active">Campanha ativa</Label>
            <Switch id="active" checked={active} onCheckedChange={setActive} />
          </div>

          <div className="flex justify-end pt-2">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Salvar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
