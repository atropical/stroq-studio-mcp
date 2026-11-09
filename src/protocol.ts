// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The wire protocol between the relay and the Studio tab: JSON text frames
 * over one WebSocket.
 *
 * Pairing is mutual and the secret never crosses the wire. The key is the
 * pairing token (26 base32 characters, ~130 bits; dashes and case ignored)
 * or, to reconnect after a reload, the resume key both sides derived when
 * they last paired. Every proof names the port the tab dialled, so a relay in
 * the middle on another port cannot pass them on.
 *
 *   tab → relay   hello     { type, protocol, mode, port, nonce }   mode 'token' | 'resume'; nonce: 32 random bytes, hex
 *   relay → tab   challenge { type, nonce, proof }    proof = HMAC-SHA256(key, "relay|" + port + "|" + tabNonce + "|" + relayNonce), hex
 *   tab → relay   prove     { type, proof }           after checking the relay's proof: HMAC(key, "tab|" + port + "|" + …)
 *   relay → tab   wait      { type, ms }              the challenge comes late (many failed handshakes lately)
 *   relay → tab   refused   { type, reason }          then the relay closes the socket
 *
 * Then both hold session = HMAC(key, "session|…") and resume = HMAC(key,
 * "resume|…"), never sent. Every later frame, both ways, is sealed:
 *
 *   { type: "sealed", seq, body, mac }   body: the frame's JSON; seq counts from 0 per direction;
 *                                        mac = HMAC(session, dir + "|" + seq + "|" + body), dir "relay" or "tab"
 *
 * A bad MAC or a sequence number out of order closes the socket. Sealed bodies:
 *
 *   relay → tab   welcome { type, protocol }          first sealed frame: paired
 *   tab → relay   tools   { type, tools: ToolInfo[] } any time; the relay tells the MCP client the list changed
 *   relay → tab   call    { type, id, name, arguments }
 *   tab → relay   result  { type, id, content, isError? }  content is MCP content (text and image blocks)
 *   either        ping / pong { type }                keep-alive
 */

export const PROTOCOL = 3;

/** The pairing token as a key: upper case, letters and digits only. */
export const tokenKey = (t: string) => t.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
export type ProofKind = 'relay' | 'tab' | 'resume' | 'session';
export const proofText = (who: ProofKind, port: number, tabNonce: string, relayNonce: string) => `${who}|${port}|${tabNonce}|${relayNonce}`;
export const macText = (dir: 'relay' | 'tab', seq: number, body: string) => `${dir}|${seq}|${body}`;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export type TabMessage =
  | { type: 'hello'; protocol: number; mode: 'token' | 'resume'; port: number; nonce: string }
  | { type: 'sealed'; seq: number; body: string; mac: string }
  | { type: 'prove'; proof: string }
  | { type: 'tools'; tools: ToolInfo[] }
  | { type: 'result'; id: number; content: Content[]; isError?: boolean }
  | { type: 'ping' }
  | { type: 'pong' };

export type RelayMessage =
  | { type: 'challenge'; nonce: string; proof: string }
  | { type: 'welcome'; protocol: number }
  | { type: 'sealed'; seq: number; body: string; mac: string }
  | { type: 'wait'; ms: number }
  | { type: 'refused'; reason: string }
  | { type: 'call'; id: number; name: string; arguments: Record<string, unknown> }
  | { type: 'ping' }
  | { type: 'pong' };

/**
 * import_model_file runs in the relay: it reads the file and sends it as
 * import_model_part calls { upload, file, size, offset, data (base64) }, then
 * calls the tab's import_model_file { upload, files: [{ name, size }],
 * lowPolyUpload?, lowPolyFiles?, name?, category?, tags? } (a low-poly version, when
 * given, goes up as its own upload, after the model). The relay lists it only when the tab lists both, and
 * never lists import_model_part.
 */
export const IMPORT_FILE = 'import_model_file';
export const IMPORT_PART = 'import_model_part';

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
      if (v.protocol !== PROTOCOL) return { type: 'hello', protocol: v.protocol, mode: 'token', port: 0, nonce: '' };
      return (v.mode === 'token' || v.mode === 'resume') && Number.isInteger(v.port) && typeof v.nonce === 'string' && HEX64.test(v.nonce)
        ? { type: 'hello', protocol: v.protocol, mode: v.mode, port: v.port as number, nonce: v.nonce }
        : null;
    case 'sealed':
      return Number.isInteger(v.seq) && (v.seq as number) >= 0 && typeof v.body === 'string' && typeof v.mac === 'string' && HEX64.test(v.mac)
        ? { type: 'sealed', seq: v.seq as number, body: v.body, mac: v.mac }
        : null;
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
