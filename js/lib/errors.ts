// What a failed request to the Tiles API means to the person who made it (U2.06), as the writing
// guide asks: what happened, why, and what they can do. Pure: the toast and the pages use it.

import { STREAM_CUT } from './api.ts';

export interface ApiFailure {
  status: number; // 0: no answer (offline, or the API is down)
  message: string; // the API's detail, or the client's words
  requestId?: string | null;
}

export type WayOut = 'back' | 'refresh' | 'sign-in' | null;

export interface Described {
  message: string; // what happened
  description?: string; // why, and what to do
  action: WayOut;
}

const sentence = (s: string): string => {
  const t = s.trim();
  return !t || /[.!?)]$/.test(t) ? t : `${t}.`;
};

export function describeApiError(e: ApiFailure): Described {
  const detail = sentence(e.message);
  switch (true) {
    case e.status === 0:
      return e.message.startsWith("You're offline") || e.message === STREAM_CUT
        ? { message: e.message, action: null }
        : {
            message: "Can't reach the Tiles API",
            description: `${detail} Check your connection, and that the API is running.`,
            action: null,
          };
    case e.status === 401:
      return {
        message: 'Your session has ended',
        description: `${detail} Sign in again to carry on.`,
        action: 'sign-in',
      };
    case e.status === 403:
      return {
        message: "You don't have access to this",
        description: `${detail} A site admin can give you the role it needs (engineer to change things, admin to manage the site).`,
        action: null,
      };
    case e.status === 404:
      return { message: 'Not found', description: `${detail} It may have been archived or removed.`, action: 'back' };
    case e.status === 409:
      return {
        message: 'This changed while you were working',
        description: `${detail} Refresh to see the latest, then try again.`,
        action: 'refresh',
      };
    case e.status === 422:
      return {
        message: "This wasn't accepted",
        description: `${detail} Correct it, then try again.`,
        action: null,
      };
    case e.status === 429:
      return { message: 'Too many requests', description: `${detail} Wait a moment, then try again.`, action: null };
    case e.status >= 500:
      return {
        message: 'The Tiles API had a problem',
        description: `${detail} Try again; if it keeps happening, give the request ID to your administrator.`,
        action: null,
      };
    default:
      return { message: e.message, action: null };
  }
}

// What "Copy details" copies: enough for support to find the request.
export function errorDetails(o: {
  what: string;
  requestId?: string | null;
  page: string;
  at: Date;
  version: string;
}): string {
  return [
    `What: ${o.what}`,
    o.requestId ? `Request ID: ${o.requestId}` : '',
    `Page: ${o.page}`,
    `Time: ${o.at.toISOString()}`,
    `Tiles: ${o.version}`,
  ]
    .filter(Boolean)
    .join('\n');
}
