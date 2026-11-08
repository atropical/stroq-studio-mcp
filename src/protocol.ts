// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The wire protocol between the relay and the Studio tab: JSON text frames
 * over one WebSocket.
 *
 *   tab → relay   hello   { type, protocol, token }        first frame; token is the pairing token or a resume key
 *   relay → tab   welcome { type, protocol, resume }       paired; resume reconnects this tab after a reload
 *   relay → tab   refused { type, reason }                 then the relay closes the socket
 *   tab → relay   tools   { type, tools: ToolInfo[] }      any time; the relay tells the MCP client the list changed
 *   relay → tab   call    { type, id, name, arguments }
 *   tab → relay   result  { type, id, content, isError? }  content is MCP content (text and image blocks)
 *   either        ping / pong { type }                     keep-alive
 */

export const PROTOCOL = 1;

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export type TabMessage =
  | { type: 'hello'; protocol: number; token: string }
  | { type: 'tools'; tools: ToolInfo[] }
  | { type: 'result'; id: number; content: Content[]; isError?: boolean }
  | { type: 'ping' }
  | { type: 'pong' };

export type RelayMessage =
  | { type: 'welcome'; protocol: number; resume: string }
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
      return typeof v.protocol === 'number' && typeof v.token === 'string' && v.token.length <= 200 ? { type: 'hello', protocol: v.protocol, token: v.token } : null;
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
