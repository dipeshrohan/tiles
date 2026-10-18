// Work orders out (T9.02): what a person may do to a work order, how it is shown, and the links that
// draft one from a warning or a component's remaining life.
import type { WorkOrder, WorkOrderStatus } from './api.ts';
import { t, type MessageKey } from './i18n.ts';

export const SHOWS = ['open', 'draft', 'approved', 'exported', 'done', 'cancelled', 'all'] as const;
export type Show = (typeof SHOWS)[number];

const STATUS: Record<WorkOrderStatus, MessageKey> = {
  draft: 'workOrders.status.draft',
  approved: 'workOrders.status.approved',
  exported: 'workOrders.status.exported',
  done: 'workOrders.status.done',
  cancelled: 'workOrders.status.cancelled',
};
export const statusLabel = (s: WorkOrderStatus): string => t(STATUS[s]);

const PRIORITY: Record<WorkOrder['priority'], MessageKey> = {
  low: 'workOrders.priority.low',
  medium: 'workOrders.priority.medium',
  high: 'workOrders.priority.high',
};
export const priorityLabel = (p: WorkOrder['priority']): string => t(PRIORITY[p]);

export type Action = 'approve' | 'done' | 'not_needed' | 'cancel';

// What `role` may do to a work order now: engineers and admins act; a draft is approved by someone
// other than its drafter, or an admin.
export function actionsFor(o: Pick<WorkOrder, 'status' | 'mine'>, role: string | null): Action[] {
  if (role !== 'engineer' && role !== 'admin') return [];
  if (o.status === 'draft') return [...(o.mine && role !== 'admin' ? [] : (['approve'] as const)), 'cancel'];
  if (o.status === 'approved' || o.status === 'exported') return ['done', 'not_needed', 'cancel'];
  return [];
}

// Where it came from, in words.
export function sourceText(o: WorkOrder): string {
  if (o.source === 'warning') return t('workOrders.from.warning', { tag: o.warning_tag ?? '' });
  if (o.source === 'remaining_life') return t('workOrders.from.component', { tag: o.signal_tag ?? '' });
  return t('workOrders.from.manual');
}

// A link that opens the Work orders page with a draft from a warning or a component, its title filled in.
export function draftHref(from: 'warning' | 'component', id: string, title: string): string {
  return `#/work-orders?${new URLSearchParams({ from, id, title }).toString()}`;
}
