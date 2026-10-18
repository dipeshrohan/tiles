import { describe, expect, it } from 'vitest';
import { actionsFor, draftHref, priorityLabel, sourceText, statusLabel } from '../js/lib/work-orders.ts';

describe('work orders (T9.02)', () => {
  it('lets engineers and admins act, and someone else approve a draft', () => {
    expect(actionsFor({ status: 'draft', mine: false }, 'engineer')).toEqual(['approve', 'cancel']);
    expect(actionsFor({ status: 'draft', mine: true }, 'engineer')).toEqual(['cancel']);
    expect(actionsFor({ status: 'draft', mine: true }, 'admin')).toEqual(['approve', 'cancel']);
    expect(actionsFor({ status: 'approved', mine: true }, 'engineer')).toEqual(['done', 'not_needed', 'cancel']);
    expect(actionsFor({ status: 'exported', mine: false }, 'admin')).toEqual(['done', 'not_needed', 'cancel']);
    expect(actionsFor({ status: 'done', mine: false }, 'admin')).toEqual([]);
    expect(actionsFor({ status: 'draft', mine: false }, 'viewer')).toEqual([]);
  });
  it('says where it came from, its status and priority', () => {
    expect(sourceText({ source: 'warning', warning_tag: 'dc1.friction' })).toBe('From a warning on dc1.friction');
    expect(sourceText({ source: 'remaining_life', signal_tag: 'w1.tip' })).toBe('From the remaining life of w1.tip');
    expect(sourceText({ source: 'manual' })).toBe('Drafted by hand');
    expect([statusLabel('done'), priorityLabel('high')]).toEqual(['Closed', 'High']);
  });
  it('links a draft with its title', () => {
    expect(draftHref('warning', 'w-1', 'Check dc1.friction & tip')).toBe(
      '#/work-orders?from=warning&id=w-1&title=Check+dc1.friction+%26+tip',
    );
  });
});
