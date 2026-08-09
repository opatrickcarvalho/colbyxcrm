/**
 * Parsing of inbound uazapi webhook payloads.
 *
 * Lives here rather than in the webhook route because a Next.js
 * `route.ts` may only export HTTP handlers — anything else fails the
 * build's route-type check, which is what left this logic untestable
 * while it sat inline.
 */

export interface ButtonReply {
  id: string;
  title: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Case-insensitive property read.
 *
 * uazapi is a Go service that serialises exported struct fields more or
 * less verbatim, so casing is not consistent even within a single
 * payload: a real button tap arrives as `selectedButtonID` (Go's
 * initialism casing) next to `Response.SelectedDisplayText` (an exported
 * field) and a lowercase `contextInfo`. Matching keys exactly meant a
 * parser written against one sample broke on the next, so every lookup
 * here is case-insensitive.
 */
function prop(
  source: Record<string, unknown> | null,
  ...names: string[]
): unknown {
  if (!source) return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const [key, value] of Object.entries(source)) {
    if (wanted.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

/**
 * Detect a button / list tap and return what was tapped.
 *
 * WhatsApp has several reply envelopes and uazapi forwards whichever one
 * the transport produced, so all of them are probed. Deliberately never
 * descends into `contextInfo`: that carries the *quoted original*, which
 * for a multi-button menu lists every button — taking an id from there
 * would report whichever one happened to come first rather than the one
 * the customer actually pressed.
 */
export function extractButtonReply(
  content: string | Record<string, unknown> | undefined
): ButtonReply | null {
  const root = obj(content);
  if (!root) return null;

  const response = obj(prop(root, 'response'));
  const buttons = obj(prop(root, 'buttonsResponseMessage'));
  const template = obj(prop(root, 'templateButtonReplyMessage'));
  const list = obj(prop(root, 'listResponseMessage'));
  const interactive = obj(prop(root, 'interactiveResponseMessage'));
  const singleSelect = obj(prop(list, 'singleSelectReply'));

  // A native-flow quick reply carries its id as a JSON *string*, e.g.
  // `{"id":"btn_1","display_text":"Resposta 01"}`. Malformed JSON there
  // is not worth failing the whole webhook over — fall through to the
  // other candidates instead.
  let nativeFlowId: string | null = null;
  let nativeFlowTitle: string | null = null;
  const nativeFlow = obj(
    prop(interactive, 'nativeFlowResponseMessage') ??
      prop(root, 'nativeFlowResponseMessage')
  );
  const paramsJson = str(prop(nativeFlow, 'paramsJson', 'buttonParamsJSON'));
  if (paramsJson) {
    try {
      const parsed = obj(JSON.parse(paramsJson));
      nativeFlowId = str(prop(parsed, 'id', 'selectedId'));
      nativeFlowTitle = str(prop(parsed, 'display_text', 'displayText'));
    } catch {
      nativeFlowId = null;
    }
  }

  const id =
    str(prop(root, 'selectedID', 'selectedButtonID')) ??
    str(prop(response, 'selectedID', 'selectedButtonID')) ??
    str(prop(buttons, 'selectedButtonID')) ??
    str(prop(template, 'selectedID')) ??
    str(prop(singleSelect, 'selectedRowID')) ??
    nativeFlowId;

  const title =
    str(prop(root, 'selectedDisplayText')) ??
    str(prop(response, 'selectedDisplayText')) ??
    str(prop(buttons, 'selectedDisplayText')) ??
    str(prop(template, 'selectedDisplayText')) ??
    str(prop(list, 'title')) ??
    str(prop(obj(prop(interactive, 'body')), 'text')) ??
    nativeFlowTitle;

  if (!id && !title) return null;
  // Either half alone is still a usable reply: an id with no label shows
  // the id in the thread, and a label with no id at least stops the
  // message from arriving blank.
  return { id: id ?? (title as string), title: title ?? (id as string) };
}
