import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Gemini's `generateContent` requires `contents` to start on `user` and
 * use `user`/`model` role names (not `assistant`). Same shape problem
 * Anthropic has — merge consecutive turns, then drop any leading
 * assistant/model turn so the transcript always starts on the customer.
 *
 * Gemini also (unlike OpenAI, and unlike Anthropic, which treats a
 * trailing assistant turn as a "continue this" prefill) hard-rejects a
 * request whose `contents` ENDS on a `model` turn with a 400 "Requests
 * ending with a model turn are not supported." That happens for real
 * here: the "draft a reply" button in the inbox can be clicked on a
 * thread where the agent's own last message is the most recent one (no
 * new customer message yet) — draft/route.ts's context ends on
 * `assistant` in that case, which OpenAI/Anthropic handle fine but
 * Gemini flatly refuses. Append a synthetic user turn asking it to
 * continue so the request shape is always valid regardless of who
 * spoke last.
 */
function normalizeForGemini(
  messages: ChatMessage[],
): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  const turns =
    merged.length > 0
      ? merged
      : [{ role: 'user' as const, content: '(The customer has not sent a message yet.)' }]
  if (turns[turns.length - 1].role === 'assistant') {
    turns.push({
      role: 'user',
      content: '(Continue the conversation — write the next message to the customer.)',
    })
  }
  return turns.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Google's Gemini `generateContent` endpoint with the caller's own
 * key. Returns the raw assistant text + token usage (handoff parsing
 * happens in `generateReply`). Uses the `x-goog-api-key` header rather
 * than the `?key=` query param so the key never lands in a URL (proxy
 * logs, browser history, etc.) — same reasoning as Anthropic's header.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: normalizeForGemini(messages),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
