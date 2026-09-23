import { readComposerData } from './vscdb.mjs';
import { readEvents } from './sidecar-read.mjs';
import { readCliChatMeta } from './cli-chats-cursor.mjs';

// The session display name for a Cursor conversation: the title Cursor itself shows, falling back to
// the first user prompt. Capped at 200 characters, matching the other two engines.
//
// Order: the IDE's composerData name, then the CLI chat's meta.json title, then its store.db name
// (never the "New Agent" placeholder), then the first sidecar prompt, then a prompt inside
// composerData. The IDE and the CLI keep separate stores, so for any one id at most one of the two
// title sources exists; the IDE goes first only because it is the older, better-known source.
//
// The fallback matters more here than for Codex: Cursor's hook set has no prompt event, so the
// sidecar only carries a prompt if the writer registered one. When it does not, the prompt is read
// out of composerData — enrichment that degrades to null rather than failing.

const MAX = 200;
// What the CLI calls every chat until `/rename` or its auto-titler names it; every headless `-p` chat
// keeps it for good. Reporting it would give all of those sessions the same name.
const CLI_PLACEHOLDER_TITLE = 'New Agent';

// TODO(P0): unverified — see lib/hook-dump.mjs
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

// The CLI title, from `meta.json` first (what `/rename` and the auto-titler write), then store.db's
// `name`. Each candidate is checked on its own, so a placeholder title cannot hide a real name.
function nameFromCli(meta) {
  if (meta === null || typeof meta !== 'object') return null;
  for (const value of [meta.title, meta.name]) {
    const text = clean(value);
    if (text && text !== CLI_PLACEHOLDER_TITLE) return text;
  }
  return null;
}

// Cursor marks a user turn as type 1 in its stored conversation array; `role` appears in the newer
// shape. Both are accepted so a format move costs the fallback, not the name.
// TODO(P0): unverified — see lib/hook-dump.mjs
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

  // The CLI never writes composerData; its title lives in its own chat store (lib/cli-chats-cursor.mjs).
  // `deps` goes through whole, so the caller's `deadline` bounds the disk work and a test's
  // `chatsDir`/`sqlite` reach the reader. `cliMeta: null` means "no CLI chat", undefined means "read".
  let cli = null;
  try {
    cli = deps.cliMeta !== undefined ? deps.cliMeta : readCliChatMeta(conversationId, deps);
  } catch {
    // The reader degrades to null on its own; this guard only keeps a naming step from ever
    // costing the hook its report.
    cli = null;
  }
  const cliName = nameFromCli(cli);
  if (cliName) return cliName;

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
