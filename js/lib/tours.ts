// Guided tours (U4.07): each a few steps, each step a part of a page (`target`, the name in a
// `data-tour="…"` attribute the page draws) with a title and a sentence or two. js/lib/tour.ts runs
// them; test/tours.test.js checks every target is still drawn by a page, and the e2e tests run each
// tour end to end. Words follow docs/ui/writing.md.

import { t, type MessageKey } from './i18n.ts';

export type TourId = 'triage' | 'plot' | 'ontology' | 'copilot';

export interface TourStep {
  page: string; // the address it is on, e.g. '#/warnings'
  target: string; // its data-tour name
  title: string;
  body: string;
  // A button or link to press when the target isn't on the page yet (the first warning, to open it),
  // as a selector inside the page.
  reveal?: string;
  // Said instead when the target isn't there (nothing to open, nothing staged).
  missing?: string;
}

export interface Tour {
  id: TourId;
  title: string;
  summary: string;
  needsApi: boolean; // its pages show the Tiles API's data
  steps: readonly TourStep[];
}

// The words are message keys, read when shown (the language may change after the app loads).
interface StepWords {
  page: string;
  target: string;
  name: MessageKey; // its title
  words: MessageKey; // its body
  reveal?: string;
  missing?: MessageKey;
}
function tourStep(w: StepWords): TourStep {
  const step: TourStep = {
    page: w.page,
    target: w.target,
    get title() {
      return t(w.name);
    },
    get body() {
      return t(w.words);
    },
  };
  if (w.reveal) step.reveal = w.reveal;
  const missing = w.missing;
  if (missing) Object.defineProperty(step, 'missing', { get: () => t(missing), enumerable: true });
  return step;
}
function tour(w: {
  id: TourId;
  name: MessageKey;
  summary: MessageKey;
  needsApi: boolean;
  steps: readonly TourStep[];
}): Tour {
  return {
    id: w.id,
    needsApi: w.needsApi,
    steps: w.steps,
    get title() {
      return t(w.name);
    },
    get summary() {
      return t(w.summary);
    },
  };
}

export const TOURS: readonly Tour[] = [
  tour({
    id: 'triage',
    name: 'tours.triage.title',
    summary: 'tours.triage.summary',
    needsApi: true,
    steps: [
      tourStep({
        page: '#/warnings',
        target: 'warning-filters',
        name: 'tours.triage.warningFilters.title',
        words: 'tours.triage.warningFilters.body',
      }),
      tourStep({
        page: '#/warnings',
        target: 'warning-list',
        name: 'tours.triage.warningList.title',
        words: 'tours.triage.warningList.body',
        missing: 'tours.triage.warningList.missing',
      }),
      tourStep({
        page: '#/warnings',
        target: 'warning-chart',
        name: 'tours.triage.warningChart.title',
        words: 'tours.triage.warningChart.body',
        reveal: '[data-warning-list] [data-warning]',
        missing: 'tours.triage.warningChart.missing',
      }),
      tourStep({
        page: '#/warnings',
        target: 'warning-actions',
        name: 'tours.triage.warningActions.title',
        words: 'tours.triage.warningActions.body',
        reveal: '[data-warning-list] [data-warning]',
        missing: 'tours.triage.warningActions.missing',
      }),
    ],
  }),
  tour({
    id: 'plot',
    name: 'tours.plot.title',
    summary: 'tours.plot.summary',
    needsApi: true,
    steps: [
      tourStep({
        page: '#/explorer',
        target: 'explorer-search',
        name: 'tours.plot.explorerSearch.title',
        words: 'tours.plot.explorerSearch.body',
      }),
      tourStep({
        page: '#/explorer',
        target: 'explorer-range',
        name: 'tours.plot.explorerRange.title',
        words: 'tours.plot.explorerRange.body',
        missing: 'tours.plot.explorerRange.missing',
      }),
      tourStep({
        page: '#/explorer',
        target: 'explorer-charts',
        name: 'tours.plot.explorerCharts.title',
        words: 'tours.plot.explorerCharts.body',
        missing: 'tours.plot.explorerCharts.missing',
      }),
    ],
  }),
  tour({
    id: 'ontology',
    name: 'tours.ontology.title',
    summary: 'tours.ontology.summary',
    needsApi: false,
    steps: [
      tourStep({
        page: '#/ontology',
        target: 'onto-canvas',
        name: 'tours.ontology.ontoCanvas.title',
        words: 'tours.ontology.ontoCanvas.body',
      }),
      tourStep({
        page: '#/ontology',
        target: 'onto-add',
        name: 'tours.ontology.ontoAdd.title',
        words: 'tours.ontology.ontoAdd.body',
        missing: 'tours.ontology.ontoAdd.missing',
      }),
      tourStep({
        page: '#/ontology',
        target: 'onto-commit',
        name: 'tours.ontology.ontoCommit.title',
        words: 'tours.ontology.ontoCommit.body',
        missing: 'tours.ontology.ontoCommit.missing',
      }),
      tourStep({
        page: '#/ontology',
        target: 'onto-tabs',
        name: 'tours.ontology.ontoTabs.title',
        words: 'tours.ontology.ontoTabs.body',
      }),
    ],
  }),
  tour({
    id: 'copilot',
    name: 'tours.copilot.title',
    summary: 'tours.copilot.summary',
    needsApi: false,
    steps: [
      tourStep({
        page: '#/chat',
        target: 'chat-examples',
        name: 'tours.copilot.chatExamples.title',
        words: 'tours.copilot.chatExamples.body',
      }),
      tourStep({
        page: '#/chat',
        target: 'chat-ask',
        name: 'tours.copilot.chatAsk.title',
        words: 'tours.copilot.chatAsk.body',
      }),
    ],
  }),
];

export const tourOf = (id: string): Tour | undefined => TOURS.find((tour) => tour.id === id);

// The tour a role starts with (U4.06's welcome offers it).
export const ROLE_TOURS: Readonly<Record<string, TourId>> = {
  engineer: 'plot',
  maintenance: 'triage',
  'shift-lead': 'triage',
  admin: 'ontology',
};

// Whether a tour can run here: one that shows the Tiles API's data needs it.
export const canRun = (tour: Tour, withApi: boolean): boolean => withApi || !tour.needsApi;
