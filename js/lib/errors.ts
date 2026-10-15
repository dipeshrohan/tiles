// What a failed request to the Tiles API means to the person who made it (U2.06), as the writing
// guide asks: what happened, why, and what they can do. Pure: the toast and the pages use it.

import { OFFLINE_WRITE, STREAM_CUT } from './api.ts';
import { t } from './i18n.ts';

export interface ApiFailure {
  status: number; // 0: no answer (offline, or the API is down)
  message: string; // the API's detail, or the client's words
  requestId?: string | null;
  code?: string | null; // ApiError.code
}

export type WayOut = 'back' | 'refresh' | 'sign-in' | null;

export interface Described {
  message: string; // what happened
  description?: string; // why, and what to do
  action: WayOut;
}

const sentence = (s: string): string => {
  const said = s.trim();
  return !said || /[.!?)]$/.test(said) ? said : `${said}.`;
};

export function describeApiError(e: ApiFailure): Described {
  const detail = sentence(e.message);
  switch (true) {
    case e.status === 0:
      return e.code === OFFLINE_WRITE || e.code === STREAM_CUT
        ? { message: e.message, action: null }
        : { message: t('errors.unreachable'), description: t('errors.unreachableWhy', { detail }), action: null };
    case e.status === 401:
      return { message: t('errors.signedOut'), description: t('errors.signedOutWhy', { detail }), action: 'sign-in' };
    case e.status === 403:
      return { message: t('errors.forbidden'), description: t('errors.forbiddenWhy', { detail }), action: null };
    case e.status === 404:
      return { message: t('errors.notFound'), description: t('errors.notFoundWhy', { detail }), action: 'back' };
    case e.status === 409:
      return { message: t('errors.conflict'), description: t('errors.conflictWhy', { detail }), action: 'refresh' };
    case e.status === 422:
      return { message: t('errors.refused'), description: t('errors.refusedWhy', { detail }), action: null };
    case e.status === 429:
      return { message: t('errors.tooMany'), description: t('errors.tooManyWhy', { detail }), action: null };
    case e.status >= 500:
      return { message: t('errors.server'), description: t('errors.serverWhy', { detail }), action: null };
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
    t('errors.details.what', { what: o.what }),
    o.requestId ? t('errors.details.request', { id: o.requestId }) : '',
    t('errors.details.page', { page: o.page }),
    t('errors.details.time', { time: o.at.toISOString() }),
    t('errors.details.version', { version: o.version }),
  ]
    .filter(Boolean)
    .join('\n');
}
