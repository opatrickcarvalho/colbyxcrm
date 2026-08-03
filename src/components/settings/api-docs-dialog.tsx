'use client';

// ============================================================
// ApiDocsDialog — Settings → API keys → "API documentation"
//
// A self-contained reference for third-party integrators: what to
// send, where, and how to read the response. Pulls its scope/event
// vocabulary straight from the source modules (SCOPE_DESCRIPTIONS,
// WEBHOOK_EVENT_DESCRIPTIONS) so it can't drift out of sync with
// what the API actually enforces.
//
// Left untranslated by design: endpoint paths, JSON bodies, header
// names, and code samples are protocol, not prose — the same reason
// `key_prefix` and scope names elsewhere in this UI stay literal.
// Only the button/dialog chrome runs through next-intl.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { API_SCOPES, SCOPE_DESCRIPTIONS } from '@/lib/api-keys/scopes';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
} from '@/lib/webhooks/events';

function Code({ children }: { children: string }) {
  return (
    <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="border-border bg-muted/60 text-foreground overflow-x-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">
      {children}
    </pre>
  );
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-sky-600 dark:text-sky-400',
  POST: 'text-emerald-600 dark:text-emerald-400',
  PATCH: 'text-amber-600 dark:text-amber-400',
  DELETE: 'text-red-600 dark:text-red-400',
};

function Endpoint({
  method,
  path,
  scope,
  children,
}: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  scope: string | null;
  children: string;
}) {
  return (
    <div className="border-border space-y-1 border-b py-2.5 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`font-mono text-xs font-semibold ${METHOD_COLORS[method]}`}
        >
          {method}
        </span>
        <span className="text-foreground font-mono text-xs">{path}</span>
        {scope ? (
          <span className="border-border bg-muted text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[10px]">
            {scope}
          </span>
        ) : (
          <span className="border-border bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">
            no scope required
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">{children}</p>
    </div>
  );
}

export function ApiDocsDialog() {
  const t = useTranslations('Settings.apiKeys.docs');
  const [open, setOpen] = useState(false);
  // Lazy initializer: the dialog's content only ever mounts client-side
  // (after the trigger is clicked), so reading `window` here can't
  // mismatch a server-rendered value.
  const [origin] = useState(() =>
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://your-domain.com'
  );

  const base = `${origin}/api/v1`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <BookOpen className="size-4" />
        {t('button')}
      </Button>

      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
          <Accordion multiple defaultValue={['quickstart']}>
            {/* ---------------------------------------------- */}
            <AccordionItem value="quickstart">
              <AccordionTrigger>{t('sections.quickstart')}</AccordionTrigger>
              <AccordionContent>
                <p>
                  Base URL: <Code>{base}</Code>
                </p>
                <p>Every request must carry the key as a bearer token:</p>
                <Pre>{`Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxx
Content-Type: application/json`}</Pre>
                <p>Verify a key and see what it&apos;s allowed to do:</p>
                <Pre>{`curl ${base}/me \\
  -H "Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxx"`}</Pre>
                <p>
                  A working call returns{' '}
                  <Code>{`{ "data": { "account": {...}, "key": { "scopes": [...] } } }`}</Code>
                  . Every other response follows the same envelope — see the{' '}
                  {t('sections.errors')} section below.
                </p>
              </AccordionContent>
            </AccordionItem>

            {/* ---------------------------------------------- */}
            <AccordionItem value="scopes">
              <AccordionTrigger>{t('sections.scopes')}</AccordionTrigger>
              <AccordionContent>
                <p>
                  A key can do only what its granted scopes allow — independent
                  of who created it. Pick the narrowest set an integration needs
                  when you mint its key.
                </p>
                <div className="space-y-1.5">
                  {API_SCOPES.map((scope) => (
                    <div key={scope} className="flex items-baseline gap-2">
                      <Code>{scope}</Code>
                      <span className="text-muted-foreground text-xs">
                        {SCOPE_DESCRIPTIONS[scope]}
                      </span>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ---------------------------------------------- */}
            <AccordionItem value="endpoints">
              <AccordionTrigger>{t('sections.endpoints')}</AccordionTrigger>
              <AccordionContent>
                <p className="text-foreground font-medium">Account</p>
                <Endpoint method="GET" path="/me" scope={null}>
                  Identity probe — returns the account and the calling
                  key&apos;s scopes.
                </Endpoint>

                <p className="text-foreground mt-3 font-medium">Contacts</p>
                <Endpoint method="GET" path="/contacts" scope="contacts:read">
                  List contacts. Query: ?search=, ?tag=, ?cursor=, ?limit= (max
                  100).
                </Endpoint>
                <Endpoint method="POST" path="/contacts" scope="contacts:write">
                  {
                    'Find-or-create a contact by phone. Body: { phone, name?, email?, company?, tags? }.'
                  }
                </Endpoint>
                <Endpoint
                  method="GET"
                  path="/contacts/{id}"
                  scope="contacts:read"
                >
                  Read one contact.
                </Endpoint>
                <Endpoint
                  method="PATCH"
                  path="/contacts/{id}"
                  scope="contacts:write"
                >
                  Update a contact. Only present fields are changed; pass tags
                  to replace them.
                </Endpoint>

                <p className="text-foreground mt-3 font-medium">
                  Conversations &amp; messages
                </p>
                <Endpoint
                  method="GET"
                  path="/conversations"
                  scope="conversations:read"
                >
                  List conversations. Query: ?status=, ?contact_id=, ?cursor=,
                  ?limit=.
                </Endpoint>
                <Endpoint
                  method="GET"
                  path="/conversations/{id}"
                  scope="conversations:read"
                >
                  Read one conversation.
                </Endpoint>
                <Endpoint
                  method="GET"
                  path="/conversations/{id}/messages"
                  scope="messages:read"
                >
                  List a conversation&apos;s messages, newest first.
                </Endpoint>
                <Endpoint method="POST" path="/messages" scope="messages:send">
                  {
                    'Send a WhatsApp message by phone number (finds-or-creates the contact/conversation). Body: { to, type?, text?, media_url?, template?, reply_to_message_id? }.'
                  }
                </Endpoint>

                <p className="text-foreground mt-3 font-medium">Broadcasts</p>
                <Endpoint
                  method="POST"
                  path="/broadcasts"
                  scope="broadcasts:send"
                >
                  {
                    'Launch a template broadcast to up to 1000 recipients. Body: { template_name, template_language?, recipients: [{ to, params? }] }.'
                  }
                </Endpoint>
                <Endpoint
                  method="GET"
                  path="/broadcasts/{id}"
                  scope="broadcasts:send"
                >
                  Poll broadcast status and delivery counts.
                </Endpoint>

                <p className="text-foreground mt-3 font-medium">Webhooks</p>
                <Endpoint method="GET" path="/webhooks" scope="webhooks:manage">
                  List your registered endpoints.
                </Endpoint>
                <Endpoint
                  method="POST"
                  path="/webhooks"
                  scope="webhooks:manage"
                >
                  {
                    'Register an endpoint. Body: { url, events: [...] }. The signing secret is returned once, in the response.'
                  }
                </Endpoint>
                <Endpoint
                  method="PATCH"
                  path="/webhooks/{id}"
                  scope="webhooks:manage"
                >
                  Update url / events / is_active.
                </Endpoint>
                <Endpoint
                  method="DELETE"
                  path="/webhooks/{id}"
                  scope="webhooks:manage"
                >
                  Remove an endpoint.
                </Endpoint>
              </AccordionContent>
            </AccordionItem>

            {/* ---------------------------------------------- */}
            <AccordionItem value="pagination">
              <AccordionTrigger>{t('sections.pagination')}</AccordionTrigger>
              <AccordionContent>
                <p>
                  List endpoints are cursor-paginated, newest first. Pass{' '}
                  <Code>?limit=</Code> (default 50, max 100) and, for later
                  pages, <Code>?cursor=</Code> from the previous response.
                </p>
                <Pre>{`GET ${base}/contacts?limit=50
→ { "data": [...], "meta": { "next_cursor": "…" } }

GET ${base}/contacts?limit=50&cursor=…
→ { "data": [...], "meta": { "next_cursor": null } }   // last page`}</Pre>
              </AccordionContent>
            </AccordionItem>

            {/* ---------------------------------------------- */}
            <AccordionItem value="errors">
              <AccordionTrigger>{t('sections.errors')}</AccordionTrigger>
              <AccordionContent>
                <p>
                  Failures always look like{' '}
                  <Code>{`{ "error": { "code", "message" } }`}</Code>. Branch on{' '}
                  <Code>code</Code>, not the message text.
                </p>
                <div className="space-y-1 font-mono text-[11px]">
                  <div>
                    <span className="text-foreground">401</span>{' '}
                    <Code>unauthorized</Code> — missing, malformed, unknown,
                    revoked, or expired key
                  </div>
                  <div>
                    <span className="text-foreground">403</span>{' '}
                    <Code>forbidden</Code> — key is missing the required scope
                  </div>
                  <div>
                    <span className="text-foreground">403</span>{' '}
                    <Code>account_suspended</Code> — the account was suspended
                  </div>
                  <div>
                    <span className="text-foreground">429</span>{' '}
                    <Code>rate_limited</Code> — see Retry-After header
                  </div>
                  <div>
                    <span className="text-foreground">400</span>{' '}
                    <Code>bad_request</Code> — malformed input
                  </div>
                  <div>
                    <span className="text-foreground">404</span>{' '}
                    <Code>not_found</Code>
                  </div>
                  <div>
                    <span className="text-foreground">500</span>{' '}
                    <Code>internal</Code>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ---------------------------------------------- */}
            <AccordionItem value="rate-limits">
              <AccordionTrigger>{t('sections.rateLimits')}</AccordionTrigger>
              <AccordionContent>
                <p>
                  Each key is limited to <Code>120 requests / minute</Code>. A
                  429 response carries <Code>Retry-After</Code>,{' '}
                  <Code>X-RateLimit-Limit</Code>,{' '}
                  <Code>X-RateLimit-Remaining</Code> and{' '}
                  <Code>X-RateLimit-Reset</Code> headers.
                </p>
              </AccordionContent>
            </AccordionItem>

            {/* ---------------------------------------------- */}
            <AccordionItem value="webhooks">
              <AccordionTrigger>{t('sections.webhooks')}</AccordionTrigger>
              <AccordionContent>
                <p>
                  Register a URL under <Code>POST /webhooks</Code> to receive
                  events as they happen instead of polling:
                </p>
                <div className="space-y-1">
                  {WEBHOOK_EVENTS.map((event) => (
                    <div key={event} className="flex items-baseline gap-2">
                      <Code>{event}</Code>
                      <span className="text-muted-foreground text-xs">
                        {WEBHOOK_EVENT_DESCRIPTIONS[event]}
                      </span>
                    </div>
                  ))}
                </div>
                <p>
                  Every delivery is signed with an{' '}
                  <Code>X-Wacrm-Signature</Code> header so you can verify it
                  really came from us and wasn&apos;t tampered with in transit:
                </p>
                <Pre>{`X-Wacrm-Signature: t=1700000000,v1=<hex HMAC-SHA256>`}</Pre>
                <p>
                  Recompute the HMAC over{' '}
                  <Code>{`\${t}.\${raw_request_body}`}</Code> using the
                  endpoint&apos;s signing secret (shown once, at creation) and
                  compare it to <Code>v1</Code>:
                </p>
                <Pre>{`const crypto = require('crypto');

function verify(rawBody, header, secret) {
  const [tPart, vPart] = header.split(',');
  const t = tPart.split('=')[1];
  const v1 = vPart.split('=')[1];
  const expected = crypto
    .createHmac('sha256', secret)
    .update(\`\${t}.\${rawBody}\`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}`}</Pre>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </DialogContent>
    </Dialog>
  );
}
