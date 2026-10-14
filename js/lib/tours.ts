// Guided tours (U4.07): each a few steps, each step a part of a page (`target`, the name in a
// `data-tour="…"` attribute the page draws) with a title and a sentence or two. js/lib/tour.ts runs
// them; test/tours.test.js checks every target is still drawn by a page, and the e2e tests run each
// tour end to end. Words follow docs/ui/writing.md.

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

export const TOURS: readonly Tour[] = [
  {
    id: 'triage',
    title: 'Triage a warning',
    summary: 'Find the warnings to work, look at the signal around one, and acknowledge, assign or resolve it.',
    needsApi: true,
    steps: [
      {
        page: '#/warnings',
        target: 'warning-filters',
        title: 'The warnings to work',
        body: 'To do lists every warning not yet resolved. Narrow it to the ones assigned to you, or to signals still out.',
      },
      {
        page: '#/warnings',
        target: 'warning-list',
        title: 'Pick a warning',
        body: 'Each row is a warning a detector raised: its signal, its detector and how long ago. Open one, or press j for the next.',
        missing: 'No warning matches the filters. Choose All to see the resolved ones.',
      },
      {
        page: '#/warnings',
        target: 'warning-chart',
        title: 'See the signal around it',
        body: 'The chart shows the signal before and after the warning: its baseline, the threshold, and the stretch that was out, shaded.',
        reveal: '[data-warning-list] [data-warning]',
        missing: 'Open a warning in the list to see its chart.',
      },
      {
        page: '#/warnings',
        target: 'warning-actions',
        title: 'Work it',
        body: 'Acknowledge it, assign it to someone, or resolve it with what it turned out to be. Every step is kept in its activity.',
        reveal: '[data-warning-list] [data-warning]',
        missing: 'Open a warning to act on it. Viewers can read warnings but not act on them.',
      },
    ],
  },
  {
    id: 'plot',
    title: 'Find and plot a signal',
    summary: 'Find a tag, plot it over a range, zoom into it and check it for wear.',
    needsApi: true,
    steps: [
      {
        page: '#/explorer',
        target: 'explorer-search',
        title: 'Find a signal',
        body: 'Type part of a tag, its description or the node it belongs to, and pick a result to plot it. You can plot up to eight.',
      },
      {
        page: '#/explorer',
        target: 'explorer-range',
        title: 'Choose the range',
        body: 'From the last hour to the last 30 days, or your own From and To. ← and → move through time.',
        missing: 'Plot a signal first: its range shows here.',
      },
      {
        page: '#/explorer',
        target: 'explorer-charts',
        title: 'Read the chart',
        body: 'Long ranges show averages with their minimum and maximum. Drag across a chart to zoom in. Each chart has a wear check.',
        missing: 'Plot a signal first: its chart shows here.',
      },
    ],
  },
  {
    id: 'ontology',
    title: 'Change the plant model',
    summary: 'Find your way around the factory map, stage a new node, then commit it with a message.',
    needsApi: false,
    steps: [
      {
        page: '#/ontology',
        target: 'onto-canvas',
        title: 'The factory map',
        body: 'Each box is a node: a site, a line, a machine, a PLC or a signal. Double-click a group to fold or unfold it, and drag to move around.',
      },
      {
        page: '#/ontology',
        target: 'onto-add',
        title: 'Stage a change',
        body: 'Choose a type, give it a label and link it to a node. It is staged: nobody else sees it until you commit.',
      },
      {
        page: '#/ontology',
        target: 'onto-commit',
        title: 'Commit it',
        body: 'Say what you changed and commit. In API mode you can send it to another engineer for review instead.',
        missing: 'Stage a node first: your staged changes and the Commit button show here.',
      },
      {
        page: '#/ontology',
        target: 'onto-tabs',
        title: 'History and health',
        body: 'History lists every commit with who made it and when; revert one with a new commit. Health lists what the model is missing.',
      },
    ],
  },
  {
    id: 'copilot',
    title: 'Ask the copilot',
    summary: 'Ask a question in your own words, and see where the answer comes from.',
    needsApi: false,
    steps: [
      {
        page: '#/chat',
        target: 'chat-examples',
        title: 'Start from an example',
        body: 'These are the kinds of question it answers. Pick one to put it in the box.',
      },
      {
        page: '#/chat',
        target: 'chat-ask',
        title: 'Ask in your own words',
        body: 'Why a line is scrapping, where a signal lives, whether a machine is wearing. With the Tiles API it answers from your site’s data and cites each source.',
      },
    ],
  },
];

export const tourOf = (id: string): Tour | undefined => TOURS.find((t) => t.id === id);

// The tour a role starts with (U4.06's welcome offers it).
export const ROLE_TOURS: Readonly<Record<string, TourId>> = {
  engineer: 'plot',
  maintenance: 'triage',
  'shift-lead': 'triage',
  admin: 'ontology',
};

// Whether a tour can run here: one that shows the Tiles API's data needs it.
export const canRun = (tour: Tour, withApi: boolean): boolean => withApi || !tour.needsApi;
