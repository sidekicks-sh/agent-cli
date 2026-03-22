import type { SidekickStep } from "./types";

export const MAX_SIDEKICK_STEPS = 10;

export const DEFAULT_SIDEKICK_STEPS: SidekickStep[] = [
  {
    id: "plan",
    name: "Plan",
    prompt: "Read the task and produce an implementation plan.",
    enabled: true,
    onPass: "next",
    onReloop: "self",
  },
  {
    id: "execute",
    name: "Execute",
    prompt: "Implement the task in the repository and verify the changes.",
    enabled: true,
    onPass: "next",
    onReloop: "self",
  },
  {
    id: "review",
    name: "Review",
    prompt: "Review the implementation and decide whether another execute pass is required.",
    enabled: true,
    onPass: "complete",
    onReloop: "step:execute",
  },
];

export function createDefaultSidekickSteps() {
  return DEFAULT_SIDEKICK_STEPS.map((step) => ({ ...step }));
}
