// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The wire protocol between the relay and the Studio tab: JSON text frames
 * over one WebSocket.
 *
 * Pairing is mutual and the secret never crosses the wire. The key is the
 * pairing token (upper case, letters and digits only) or, to reconnect after
 * a reload, the resume key both sides derived when they last paired.
 *
 *   tab → relay   hello     { type, protocol, mode, nonce }   mode 'token' | 'resume'; nonce: 32 random bytes, hex
 *   relay → tab   challenge { type, nonce, proof }            proof = HMAC-SHA256(key, "relay|" + tabNonce + relayNonce), hex
 *   tab → relay   prove     { type, proof }                   after checking the relay's proof: HMAC(key, "tab|" + tabNonce + relayNonce)
 *   relay → tab   welcome   { type, protocol }                paired; both now hold resume = HMAC(key, "resume|" + tabNonce + relayNonce)
 *   relay → tab   refused   { type, reason }                  then the relay closes the socket
 *   tab → relay   tools   { type, tools: ToolInfo[] }      any time; the relay tells the MCP client the list changed
 *   relay → tab   call    { type, id, name, arguments }
 *   tab → relay   result  { type, id, content, isError? }  content is MCP content (text and image blocks)
 *   either        ping / pong { type }                     keep-alive
 */

export const PROTOCOL = 2;

/** The pairing token as a key: upper case, letters and digits only. */
export const tokenKey = (t: string) => t.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
export const proofText = (who: 'relay' | 'tab' | 'resume', tabNonce: string, relayNonce: string) => `${who}|${tabNonce}${relayNonce}`;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export type TabMessage =
  | { type: 'hello'; protocol: number; mode: 'token' | 'resume'; nonce: string }
  | { type: 'prove'; proof: string }
  | { type: 'tools'; tools: ToolInfo[] }
  | { type: 'result'; id: number; content: Content[]; isError?: boolean }
  | { type: 'ping' }
  | { type: 'pong' };

export type RelayMessage =
  | { type: 'challenge'; nonce: string; proof: string }
  | { type: 'welcome'; protocol: number }
  | { type: 'refused'; reason: string }
  | { type: 'call'; id: number; name: string; arguments: Record<string, unknown> }
  | { type: 'ping' }
  | { type: 'pong' };

/** Largest frame the relay accepts from the tab (screenshots are big). */
export const MAX_FRAME = 32 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isContent(v: unknown): v is Content {
  if (!isObj(v)) return false;
  if (v.type === 'text') return typeof v.text === 'string';
  if (v.type === 'image') return typeof v.data === 'string' && typeof v.mimeType === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(v.mimeType);
  return false;
}

function isTool(v: unknown): v is ToolInfo {
  return (
    isObj(v) &&
    typeof v.name === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(v.name) &&
    (v.description === undefined || typeof v.description === 'string') &&
    isObj(v.inputSchema) &&
    v.inputSchema.type === 'object'
  );
}

/** A frame from the tab, checked; null when it is not one. */
export function parseTabMessage(raw: string): TabMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'hello':
      if (typeof v.protocol !== 'number') return null;
      // Another protocol version gets a clear refusal, whatever else it sent.
      if (v.protocol !== PROTOCOL) return { type: 'hello', protocol: v.protocol, mode: 'token', nonce: '' };
      return (v.mode === 'token' || v.mode === 'resume') && typeof v.nonce === 'string' && HEX64.test(v.nonce) ? { type: 'hello', protocol: v.protocol, mode: v.mode, nonce: v.nonce } : null;
    case 'prove':
      return typeof v.proof === 'string' && HEX64.test(v.proof) ? { type: 'prove', proof: v.proof } : null;
    case 'tools':
      return Array.isArray(v.tools) && v.tools.length <= 500 && v.tools.every(isTool) ? { type: 'tools', tools: v.tools } : null;
    case 'result':
      return Number.isInteger(v.id) && Array.isArray(v.content) && v.content.every(isContent)
        ? { type: 'result', id: v.id as number, content: v.content, isError: v.isError === true }
        : null;
    case 'ping':
    case 'pong':
      return { type: v.type };
    default:
      return null;
  }
}
