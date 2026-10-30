import { describe, expect, it } from 'vitest';
import { intentMarkdown } from './server.js';

describe('friday://intent (ADR-0034 §5)', () => {
  it('shows the approved project intent and the goal intent, the planner lines labelled', () => {
    const text = intentMarkdown({
      project: {
        version: 2,
        objective: 'A distraction-free study platform.',
        constraints: [{ text: 'Never show ads.' }],
        outcomes: [],
        non_goals: [{ text: 'Social feeds.' }],
        definition_of_done: [],
      },
      goal: {
        goal_id: 'goal_1',
        objective: 'Refactor the video cards',
        intent_revision: 3,
        constraints: [],
        outcomes: [],
        non_goals: ['No new npm packages.'],
        definition_of_done: ['The dashboard builds.'],
        inferred_constraints: ['Keep the card props.'],
        inferred_outcomes: [],
        inferred_non_goals: [],
        inferred_definition_of_done: [],
      },
    });
    expect(text).toContain('Version 2 (approved by a human): A distraction-free study platform.');
    expect(text).toContain('- Not a goal: Social feeds.');
    expect(text).toContain('Goal goal_1 (revision 3): Refactor the video cards');
    expect(text).toContain('- Done when: The dashboard builds.');
    expect(text).toContain('- Constraint (suggested by the planner): Keep the card props.');
  });

  it('says so when nothing is approved and no goal is held', () => {
    const text = intentMarkdown({ project: null, goal: null });
    expect(text).toContain('No approved project intent yet.');
    expect(text).toContain('You hold no task of a goal.');
  });
});
