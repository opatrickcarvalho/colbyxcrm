'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

const DEFAULT_TEMPLATE = 'Olá! Vim pelo anúncio @{code}';

// Client-side mirror of slugifyCampaignCode (src/lib/attribution/code.ts)
// for the live preview only — kept local, not imported, because that
// module also pulls in node:crypto (generateCampaignCode), which a
// client bundle can't resolve. The server re-sanitizes on submit
// regardless, so this only needs to look right, not be authoritative.
function previewSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 30);
}

export default function NewAdCampaignPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [messageTemplate, setMessageTemplate] = useState(DEFAULT_TEMPLATE);
  const [saving, setSaving] = useState(false);

  // The code follows the name until the operator edits it directly —
  // same pattern as a URL slug field following a title.
  const displayedCode = codeTouched ? code : previewSlug(name);

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Dê um nome para a campanha');
      return;
    }
    if (!messageTemplate.includes('{code}')) {
      toast.error('A mensagem precisa conter o placeholder {code}');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/ad-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          message_template: messageTemplate,
          code: codeTouched ? code : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Falha ao criar campanha');
      toast.success('Campanha criada');
      router.push(`/ad-links/${data.data.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao criar campanha');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Nova campanha</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gera um link de rastreamento e um texto pré-preenchido para colar no anúncio.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-2">
            <Label htmlFor="name">Nome da campanha</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Promoção de verão — Instagram"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="code">Código de rastreamento</Label>
            <Input
              id="code"
              value={displayedCode}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(previewSlug(e.target.value));
              }}
              placeholder="Ex: SalvadosCardoso"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Aparece como <span className="font-mono">@{displayedCode || 'codigo'}</span> na
              mensagem — use algo reconhecível, como o @ do Instagram ou o nome da empresa, em vez
              de um código aleatório.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="template">Mensagem pré-preenchida</Label>
            <Textarea
              id="template"
              rows={3}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              O placeholder <code className="font-mono">{'{code}'}</code> é substituído pelo
              código acima. Pré-visualização:{' '}
              <span className="font-mono">
                {messageTemplate.replace('{code}', displayedCode || 'codigo')}
              </span>
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => router.push('/ad-links')} disabled={saving}>
              Cancelar
            </Button>
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
