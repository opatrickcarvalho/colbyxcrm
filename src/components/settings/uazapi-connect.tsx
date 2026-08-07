'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Loader2,
  QrCode,
  RefreshCw,
  RotateCcw,
  Unplug,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * QR-code pairing for the UAZAPI provider.
 *
 * Two timers drive this screen, and they exist for different reasons:
 *
 *   * uazapi expires a QR code after two minutes, so the code has to be
 *     re-fetched rather than rendered once. We refresh slightly early
 *     to avoid showing a dead code.
 *   * the scan completes on the operator's phone, not here, so the only
 *     way to learn about it is to poll the status endpoint.
 *
 * Both stop the moment the instance reports `connected`.
 */

type Status = 'disconnected' | 'connecting' | 'connected' | 'hibernated';

/** Refresh a beat before uazapi's 120s expiry rather than exactly on it. */
const QR_REFRESH_MS = 110_000;
const POLL_MS = 3_000;

interface Props {
  /** Status already known from the config row, to avoid a blank first paint. */
  initialStatus?: Status;
  /** Lets the parent re-read the config row after a connect/disconnect. */
  onChanged?: () => void;
}

export function UazapiConnect({
  initialStatus = 'disconnected',
  onChanged,
}: Props) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // 'all' | 'none' | null (unknown / not checked yet), straight from
  // the paired account's WhatsApp privacy settings.
  const [readReceipts, setReadReceipts] = useState<string | null>(null);

  // Held in refs so the polling effect can clear them without listing
  // them as dependencies and restarting itself on every tick.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    pollTimer.current = null;
    refreshTimer.current = null;
  }, []);

  const requestQr = useCallback(async () => {
    setPairing(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
      });
      const data = await res.json();

      if (!res.ok) {
        // 409 is the deliberate guard against switching away from a
        // live Meta connection that still has conversations.
        if (res.status === 409) {
          toast.error(data.error, { duration: 8000 });
        } else if (res.status === 503) {
          toast.error(
            'UAZAPI is not enabled on this deployment. Ask the administrator to set UAZAPI_HOST and UAZAPI_ADMIN_TOKEN.',
            { duration: 8000 }
          );
        } else {
          toast.error(data.error ?? 'Could not start pairing.');
        }
        setQrcode(null);
        return;
      }

      setStatus(data.status ?? 'connecting');
      setQrcode(data.qrcode ?? null);

      if (data.status !== 'connected') {
        refreshTimer.current = setTimeout(() => {
          void requestQr();
        }, QR_REFRESH_MS);
      }
    } catch {
      toast.error('Could not reach the server to start pairing.');
      setQrcode(null);
    } finally {
      setPairing(false);
    }
  }, []);

  // Poll while a pairing is in flight. The scan happens on a phone, so
  // there is no local event to listen for.
  useEffect(() => {
    if (status === 'connected' || (!qrcode && status !== 'connecting')) {
      return;
    }

    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/uazapi/status');
        if (!res.ok) return;
        const data = await res.json();

        if (data.connected) {
          clearTimers();
          setStatus('connected');
          setQrcode(null);
          setProfileName(data.profile_name ?? null);
          toast.success('WhatsApp connected.');
          onChanged?.();
        } else if (data.status) {
          setStatus(data.status);
        }
      } catch {
        // A transient network blip should not tear the screen down —
        // the next tick retries.
      }
    }, POLL_MS);

    return clearTimers;
  }, [status, qrcode, clearTimers, onChanged]);

  // Re-applies the webhook event subscription + "available" presence
  // that connect/route.ts only sets at PAIRING time. A connection
  // established before those two behaviors shipped never got them —
  // symptom is delivery/read ticks stuck at "sent" and no typing
  // indicator reaching the customer, since uazapi silently drops
  // messages_update webhooks while the instance sits at
  // presence=unavailable.
  const sync = useCallback(async (enableReadReceipts = false) => {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable_read_receipts: enableReadReceipts }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Could not sync the connection.');
        return;
      }
      setReadReceipts(data.readReceipts ?? null);
      if (data.readReceipts === 'none') {
        toast.warning(
          'Synced, but this WhatsApp account has read receipts turned off — blue ticks cannot arrive until that changes.',
          { duration: 8000 }
        );
      } else {
        toast.success('Connection synced.');
      }
    } catch {
      toast.error('Could not reach the server to sync.');
    } finally {
      setSyncing(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/disconnect', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Could not disconnect.');
        return;
      }
      clearTimers();
      setStatus('disconnected');
      setQrcode(null);
      setProfileName(null);
      toast.success('WhatsApp disconnected.');
      onChanged?.();
    } catch {
      toast.error('Could not reach the server to disconnect.');
    } finally {
      setDisconnecting(false);
    }
  }, [clearTimers, onChanged]);

  if (status === 'connected') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            Connected via UAZAPI
          </CardTitle>
          <CardDescription>
            {profileName
              ? `Paired with ${profileName}.`
              : 'Your number is paired and receiving messages.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>Unofficial provider</AlertTitle>
            <AlertDescription>
              UAZAPI is not operated by Meta. There are no pre-approved message
              templates and no 24-hour session window, so the Templates screen
              stays hidden while this provider is active.
            </AlertDescription>
          </Alert>
          {readReceipts === 'none' && (
            <Alert>
              <AlertTitle>Read receipts are off on this number</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  WhatsApp read receipts are reciprocal: while this account has
                  them disabled it neither sends blue ticks nor receives them,
                  so messages sent from the inbox stay on two grey ticks no
                  matter what. Delivery ticks are unaffected.
                </p>
                <p>
                  Turning this on also means this number starts sending read
                  receipts to everyone it chats with — including from the phone
                  itself.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void sync(true)}
                  disabled={syncing}
                >
                  Turn on read receipts
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void sync()}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Sync connection
            </Button>
            <Button
              variant="outline"
              onClick={disconnect}
              disabled={disconnecting}
            >
              {disconnecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="mr-2 h-4 w-4" />
              )}
              Disconnect
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            &quot;Sync connection&quot; re-registers the webhook, marks the
            number as available, and reports whether read receipts are enabled —
            no need to re-scan the QR code.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="h-5 w-5" />
          Connect by QR code
        </CardTitle>
        <CardDescription>
          Open WhatsApp on your phone, go to Settings → Linked devices → Link a
          device, and scan the code below.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {qrcode ? (
          <div className="space-y-3">
            <div className="flex justify-center rounded-lg border bg-white p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- base64 data URI from the provider, not an optimizable asset */}
              <img
                src={
                  qrcode.startsWith('data:')
                    ? qrcode
                    : `data:image/png;base64,${qrcode}`
                }
                alt="WhatsApp pairing QR code"
                className="h-56 w-56"
              />
            </div>
            <p className="text-muted-foreground text-center text-sm">
              This code expires after two minutes and refreshes on its own.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void requestQr()}
              disabled={pairing}
            >
              {pairing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Refresh code
            </Button>
          </div>
        ) : (
          <Button
            className="w-full"
            onClick={() => void requestQr()}
            disabled={pairing}
          >
            {pairing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <QrCode className="mr-2 h-4 w-4" />
            )}
            Generate QR code
          </Button>
        )}

        <Alert>
          <AlertTitle>What you give up</AlertTitle>
          <AlertDescription>
            UAZAPI is an unofficial bridge. It has no message templates and no
            approval flow, and Meta may block numbers it considers abusive. The
            official Meta API remains available in the picker above.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
