/**
 * Spintax renderer for campaign messages.
 *
 * Bulk WhatsApp sends that go out byte-identical get flagged by anti-spam
 * heuristics on the provider side, so a campaign template is allowed to
 * describe *a family* of messages — `{Ola|Oi}, {{primeiro_nome}}!` — and
 * this module picks one concrete variant per recipient. Pure and
 * deterministic given an `rng`, so the same template can be replayed in
 * tests and previewed on both the server (send path) and the client
 * (composer preview) without pulling in a random source of its own.
 */

export interface SpintaxVars {
  [key: string]: string | undefined;
}

export interface RenderOptions {
  vars?: SpintaxVars;
  /** Defaults to Math.random; inject a fake for deterministic tests/previews. */
  rng?: () => number;
  /** Defaults to false — see insertInvisibleChars() for why it's opt-in. */
  invisibleChars?: boolean;
}

/**
 * Small, curated, business-safe set for `{{emoji}}`. Kept short on purpose:
 * a "random emoji" feature that can land on anything (skulls, eggplants,
 * flags) is a support ticket waiting to happen, so this list is limited to
 * friendly, unambiguous ones a business would send a customer.
 */
const EMOJIS = [
  '😊',
  '🙂',
  '👍',
  '✅',
  '🎉',
  '🙌',
  '⭐',
  '💬',
  '📅',
  '✨',
  '🤝',
  '👋',
] as const;

// ---------------------------------------------------------------------------
// Parsing
//
// A template parses into a Node[] sequence. Rotation groups nest (each
// option is itself a Node[]), which is what lets `{Ola|{Oi|E ai}}` work
// without special-casing depth anywhere else in this file.
// ---------------------------------------------------------------------------

type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string }
  | { type: 'group'; options: Node[][] };

/** A `{{identifier}}` with no `|` or nested `{` inside — never a rotation group. */
const VARIABLE_RE = /^\{\{([a-zA-Z0-9_]+)\}\}/;

class SpintaxSyntaxError extends Error {}

/**
 * Recursive-descent parser over a single mutable cursor. `stopAt` is what
 * lets one function serve both the top level (stops only at end-of-string)
 * and a group option (stops at the `|` that starts the next option, or the
 * `}` that closes the group) without duplicating the scanning loop.
 */
function parseTemplate(template: string): Node[] {
  let i = 0;
  const n = template.length;

  function parseSequence(stopAt: ReadonlySet<string>): Node[] {
    const nodes: Node[] = [];
    let buf = '';
    const flush = () => {
      if (buf) {
        nodes.push({ type: 'text', value: buf });
        buf = '';
      }
    };

    while (i < n) {
      const c = template[i];
      if (stopAt.has(c)) break;

      // Escapes win over everything else so `\{`, `\}`, `\|` never reach
      // the syntax below, whatever scope they appear in.
      if (
        c === '\\' &&
        i + 1 < n &&
        (template[i + 1] === '{' ||
          template[i + 1] === '}' ||
          template[i + 1] === '|')
      ) {
        buf += template[i + 1];
        i += 2;
        continue;
      }

      if (c === '{') {
        const m = VARIABLE_RE.exec(template.slice(i));
        if (m) {
          flush();
          nodes.push({ type: 'var', name: m[1] });
          i += m[0].length;
          continue;
        }
        flush();
        nodes.push(parseGroup());
        continue;
      }

      if (c === '}') {
        // Not in stopAt (checked above), so this scope wasn't expecting a
        // close — it belongs to no group that's currently open.
        throw new SpintaxSyntaxError(
          `Unmatched closing brace '}' at position ${i}.`
        );
      }

      buf += c;
      i++;
    }

    flush();
    return nodes;
  }

  function parseGroup(): Node {
    const start = i;
    i++; // consume the opening '{'
    const options: Node[][] = [];

    for (;;) {
      options.push(parseSequence(new Set(['|', '}'])));
      if (i >= n) {
        throw new SpintaxSyntaxError(
          `Unterminated group: missing '}' for the '{' opened at position ${start}.`
        );
      }
      if (template[i] === '|') {
        i++;
        continue;
      }
      // template[i] === '}'
      i++;
      break;
    }

    return { type: 'group', options };
  }

  const nodes = parseSequence(new Set());
  if (i < n) {
    // parseSequence only stops early on a '}', and the top level passes an
    // empty stopAt — so reaching here means the scan above already threw.
    // Kept as a guard in case that invariant ever changes.
    throw new SpintaxSyntaxError(
      `Unmatched closing brace '}' at position ${i}.`
    );
  }
  return nodes;
}

/**
 * Best-effort literal rendering for a template that failed to parse.
 * `renderMessage` must never throw at send time — a campaign with one bad
 * template shouldn't take the whole batch down — so on unbalanced syntax we
 * fall back to showing the author's intent as plain text: unescaped
 * `{`, `}`, `|` are dropped, escaped ones become the literal character.
 * No variable or rotation resolution happens on this path; callers should
 * use `validateSpintax` ahead of time to catch this case with a real error.
 */
function stripSyntax(template: string): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (
      c === '\\' &&
      i + 1 < template.length &&
      (template[i + 1] === '{' ||
        template[i + 1] === '}' ||
        template[i + 1] === '|')
    ) {
      out += template[i + 1];
      i++;
      continue;
    }
    if (c === '{' || c === '}' || c === '|') continue;
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pickIndex(length: number, rng: () => number): number {
  if (length <= 1) return 0;
  // Clamp: an rng() that returns exactly 1 (or a hostile fake in tests)
  // must not index past the end of the array.
  return Math.min(length - 1, Math.max(0, Math.floor(rng() * length)));
}

function resolveVar(
  name: string,
  vars: SpintaxVars,
  rng: () => number
): string {
  // {{emoji}} is a synthetic variable, not a lookup — each occurrence
  // draws independently, same as a rotation group would.
  if (name === 'emoji') return EMOJIS[pickIndex(EMOJIS.length, rng)];
  return vars[name] ?? '';
}

/**
 * Depth-first resolution. Rotation happens first at each group (pick one
 * option), then that option's own nodes are resolved — which is what makes
 * variables "resolved after rotation" per group without needing a separate
 * pass: a variable inside an option that wasn't picked is never visited.
 * Variable values are spliced in as-is; they are never fed back through
 * parseTemplate, so a contact literally named "{a|b}" comes out unchanged.
 */
function resolveNodes(
  nodes: Node[],
  vars: SpintaxVars,
  rng: () => number
): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
    } else if (node.type === 'var') {
      out += resolveVar(node.name, vars, rng);
    } else {
      const chosen = node.options[pickIndex(node.options.length, rng)];
      out += resolveNodes(chosen, vars, rng);
    }
  }
  return out;
}

/**
 * Zero-width space (U+200B) sprinkled roughly every 12th word, capped at 5
 * per message. Opt-in anti-fingerprinting measure so a byte-diff between
 * two recipients' messages doesn't cleanly line up on whitespace — but some
 * WhatsApp clients render U+200B as a visible glyph or a line-break
 * opportunity in odd spots, so it's off by default and left to the caller
 * to enable per campaign.
 */
function insertInvisibleChars(text: string): string {
  const words = text.split(' ');
  let inserted = 0;
  const out = words.map((word, idx) => {
    const wordNumber = idx + 1;
    if (wordNumber % 12 === 0 && inserted < 5) {
      inserted++;
      return word + '​';
    }
    return word;
  });
  return out.join(' ');
}

export function renderMessage(
  template: string,
  options: RenderOptions = {}
): string {
  const rng = options.rng ?? Math.random;
  const vars = options.vars ?? {};

  let nodes: Node[];
  try {
    nodes = parseTemplate(template);
  } catch {
    return stripSyntax(template);
  }

  const resolved = resolveNodes(nodes, vars, rng);
  // An unknown/undefined variable resolves to "", which leaves a run of
  // 2+ spaces wherever the template padded it (e.g. "Oi {{nome}} tudo
  // bem" -> "Oi  tudo bem"). Collapsing here, once, after resolution is
  // simpler and safer than trying to special-case only the gaps a missing
  // variable created.
  const collapsed = resolved.replace(/ {2,}/g, ' ').trim();

  return options.invisibleChars ? insertInvisibleChars(collapsed) : collapsed;
}

export function validateSpintax(
  template: string
): { ok: true } | { ok: false; error: string } {
  try {
    parseTemplate(template);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid spintax template.',
    };
  }
}

const MAX_COUNT = Number.MAX_SAFE_INTEGER;

// Saturating multiply/add: a template with several wide groups multiplies
// out fast (10 groups of 10 options is already 10 billion), so plain `*`
// would blow past Number.MAX_SAFE_INTEGER and start losing precision long
// before it overflows to Infinity. Capping at each step keeps the running
// total exact for anything that matters and just pins it at the ceiling
// once it stops mattering.
function saturatingMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  if (a > MAX_COUNT / b) return MAX_COUNT;
  return a * b;
}

function saturatingAdd(a: number, b: number): number {
  return Math.min(MAX_COUNT, a + b);
}

function countSequence(nodes: Node[]): number {
  let total = 1;
  for (const node of nodes) {
    total = saturatingMul(total, countNode(node));
    if (total >= MAX_COUNT) return MAX_COUNT;
  }
  return total;
}

function countNode(node: Node): number {
  if (node.type === 'group') {
    let sum = 0;
    for (const option of node.options) {
      sum = saturatingAdd(sum, countSequence(option));
      if (sum >= MAX_COUNT) return MAX_COUNT;
    }
    return sum;
  }
  // text and {{var}} nodes each render to exactly one thing.
  return 1;
}

export function countVariants(template: string): number {
  try {
    return countSequence(parseTemplate(template));
  } catch {
    // Malformed input renders as a single literal string (see stripSyntax),
    // so it has exactly one variant.
    return 1;
  }
}
