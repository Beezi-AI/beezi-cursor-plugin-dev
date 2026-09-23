// The model a generation ran on, without the parameters the user picked for it.
//
// Cursor's `model` field is what its docs call a "legacy model slug": the model id with the values of
// `model_params` folded onto the end ("claude-opus-5-thinking-high" = claude-opus-5, thinking=true,
// effort=high). Builds that also send `model_id` let lib/sidecar-events.mjs read the id directly;
// the CLI sends ONLY the slug (evidence E2 in docs/superpowers/plans/2026-09-23-cursor-cli-parity.md),
// and older IDE builds did too (E4). Recording the slug turned one model into a row per effort level
// in the portal ("Claude Opus 5 Thinking High"), each with its own pricing lookup.
//
// Stripped ONLY from the right and ONLY known words, so a model whose real name ends in something
// that merely looks like a parameter ("gemini-3.5-flash", "gpt-5-mini") is untouched. The raw slug is
// never thrown away: callers keep it as `model_variant`, because Cursor prices per slug in usageData.
//
// Pure and total: every input maps to a string or null, nothing throws, because this runs inside hook
// paths that must never fail on a malformed payload.

// Effort levels (docs: low/medium/high/xhigh/max), the thinking toggle, context sizes and fast mode.
// `fast` is stripped by the user's decision of 2026-09-23: a fast-mode run is the same model for
// reporting purposes, and the slug still carries it in `model_variant` for pricing.
const SUFFIX_WORDS = new Set([
  'thinking',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'fast',
  '300k',
  '1m',
]);

// `default` is Cursor's Auto: the router picked the model and the hooks never say which (E3).
// `auto` is the same thing under the name the UI uses.
const PLACEHOLDERS = new Set(['default', 'auto']);

export function baseModelId(slug) {
  if (typeof slug !== 'string') return null;
  let text = slug.trim();
  if (text === '') return null;
  // The CLI's `--model` syntax, which subagent definitions use too: "claude-opus-5[effort=high]".
  // A bracket at index 0 has no name in front of it, so the text is left alone rather than emptied.
  // Trimmed again because "name [effort=high]" would otherwise keep the space before the bracket.
  const bracket = text.indexOf('[');
  if (bracket > 0) text = text.slice(0, bracket).trim();
  const parts = text.split('-');
  // Always keep at least one part: a slug that is nothing but suffix words is a name, not params.
  // Suffix words compare case-insensitively so a differently cased slug still collapses, while the
  // kept base keeps the casing it arrived with: this never renames a model, it only shortens it.
  while (parts.length > 1 && SUFFIX_WORDS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts.join('-');
}

// True only for the router placeholders. Callers use it to decide that a generation's model is still
// unknown and must be resolved elsewhere (lib/cli-chats-cursor.mjs), never to drop the generation.
export function isPlaceholderModel(slug) {
  return typeof slug === 'string' && PLACEHOLDERS.has(slug.trim().toLowerCase());
}
