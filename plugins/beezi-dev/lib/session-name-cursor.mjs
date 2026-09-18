import { readComposerData } from './vscdb.mjs';
import { readEvents } from './sidecar-read.mjs';

// The session display name for a Cursor conversation: the title Cursor itself shows, falling back to
// the first user prompt. Capped at 200 characters, matching the other two engines.
//
// The fallback matters more here than for Codex: Cursor's hook set has no prompt event, so the
// sidecar only carries a prompt if the writer registered one. When it does not, the prompt is read
// out of composerData — enrichment that degrades to null rather than failing.

const MAX = 200;

// TODO(P0): unverified — Cursor not installed on the authoring machine
const NAME_FIELDS = ['name', 'title', 'composerTitle'];
const PROMPT_EVENTS = new Set(['prompt', 'user', 'user_message', 'user_prompt']);
const PROMPT_TEXT_FIELDS = ['text', 'prompt', 'message', 'content'];
const MESSAGE_LISTS = ['conversation', 'messages', 'fullConversationHeadersOnly'];

function clean(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text.slice(0, MAX);
}

function pick(record, fields) {
  for (const field of fields) {
    const found = clean(record == null ? undefined : record[field]);
    if (found) return found;
  }
  return null;
}

// Cursor marks a user turn as type 1 in its stored conversation array; `role` appears in the newer
// shape. Both are accepted so a format move costs the fallback, not the name.
// TODO(P0): unverified — Cursor not installed on the authoring machine
function isUserMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  if (message.type === 1) return true;
  return message.role === 'user';
}

function promptFromComposer(composer) {
  for (const list of MESSAGE_LISTS) {
    const messages = composer == null ? undefined : composer[list];
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!isUserMessage(message)) continue;
      const text = pick(message, PROMPT_TEXT_FIELDS);
      if (text) return text;
    }
  }
  return null;
}

function promptFromEvents(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || !PROMPT_EVENTS.has(event.ev)) continue;
    const text = pick(event, PROMPT_TEXT_FIELDS);
    if (text) return text;
  }
  return null;
}

export function resolveSessionName(conversationId, deps = {}) {
  if (!conversationId) return null;

  const composer =
    deps.composerData !== undefined
      ? deps.composerData
      : readComposerData(conversationId, deps);

  const name = pick(composer, NAME_FIELDS);
  if (name) return name;

  const readEventsImpl = deps.readEvents == null ? ((id) => readEvents(id, deps)) : deps.readEvents;
  let events = [];
  try {
    events = readEventsImpl(conversationId);
  } catch {
    events = [];
  }

  const fromEvents = promptFromEvents(events);
  return fromEvents == null ? promptFromComposer(composer) : fromEvents;
}
