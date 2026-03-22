import { z } from "zod";

import type {
  ReservedTask,
  SidekickRegistration,
  SidekickStep,
  SidekickStepOnReloop,
} from "./types";
import {
  MAX_SIDEKICK_STEPS,
  createDefaultSidekickSteps,
} from "./workflow";

export { DEFAULT_SIDEKICK_STEPS, MAX_SIDEKICK_STEPS } from "./workflow";

const nonEmptyString = z.string().trim().min(1, "must be a non-empty string");
const stepIdSchema = z
  .string()
  .trim()
  .min(1, "must be a non-empty string")
  .max(32, "must be at most 32 characters")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must match slug format (lowercase letters, numbers, hyphen)",
  );
const reloopSchema = z
  .string()
  .trim()
  .regex(
    /^self$|^step:[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be one of self or step:<id>",
  );

const sidekickStepSchema = z
  .object({
    id: stepIdSchema,
    name: z.string().trim().min(1).max(60),
    prompt: z.string().trim().min(1).max(4_000),
    enabled: z.boolean(),
    onPass: z.enum(["next", "complete"]),
    onReloop: reloopSchema,
  })
  .transform((value) => ({
    ...value,
    onReloop: value.onReloop as SidekickStepOnReloop,
  }));

const registrationPayloadSchema = z
  .object({
    id: z.string().optional(),
    name: nonEmptyString.optional(),
    purpose: nonEmptyString.optional(),
    prompt: z.string().optional(),
    steps: z.unknown().optional(),
  })
  .transform((value) => {
    const normalizedSteps = normalizeSidekickSteps(value.steps);

    return {
      id: value.id,
      name: value.name ?? "sidekick",
      purpose: value.purpose ?? "unknown",
      prompt: value.prompt ?? "",
      steps: normalizedSteps.steps,
      stepConfigWarnings: normalizedSteps.warnings,
    };
  });

const reservedTaskPayloadSchema = z
  .object({
    task_id: nonEmptyString,
    run_id: nonEmptyString,
    task_title: nonEmptyString,
    repo_url: nonEmptyString,
    repo_name: nonEmptyString,
    base_branch: nonEmptyString,
    execution_branch: nonEmptyString,
    instructions: nonEmptyString,
  })
  .transform((value) => ({
    taskId: value.task_id,
    runId: value.run_id,
    taskTitle: value.task_title,
    repoUrl: value.repo_url,
    repoName: value.repo_name,
    baseBranch: value.base_branch,
    executionBranch: value.execution_branch,
    instructions: value.instructions,
  }));

export function parseRegistrationPayload(
  payload: unknown,
): SidekickRegistration {
  const result = registrationPayloadSchema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  throw new Error(
    `Invalid registration payload: ${formatIssues(result.error.issues)}`,
  );
}

export function parseReservedTaskPayload(payload: unknown): ReservedTask {
  const result = reservedTaskPayloadSchema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  throw new Error(
    `Invalid reserved task payload: ${formatIssues(result.error.issues)}`,
  );
}

export function parseSidekickSteps(payload: unknown): SidekickStep[] {
  const parsed = z
    .array(sidekickStepSchema)
    .min(1, "steps must include at least one item")
    .max(MAX_SIDEKICK_STEPS, `steps must include at most ${MAX_SIDEKICK_STEPS} items`)
    .safeParse(payload);

  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error.issues));
  }

  const steps = parsed.data;
  const issues: string[] = [];
  const byId = new Map<string, SidekickStep>();

  for (const step of steps) {
    if (byId.has(step.id)) {
      issues.push(`steps.${step.id}: id must be unique`);
      continue;
    }

    byId.set(step.id, step);
  }

  if (steps.every((step) => !step.enabled)) {
    issues.push("steps: at least one step must be enabled");
  }

  for (const step of steps) {
    if (!step.onReloop.startsWith("step:")) {
      continue;
    }

    const target = step.onReloop.slice("step:".length);
    const targetStep = byId.get(target);
    if (!targetStep) {
      issues.push(
        `steps.${step.id}.onReloop: target step '${target}' does not exist`,
      );
      continue;
    }

    if (!targetStep.enabled) {
      issues.push(
        `steps.${step.id}.onReloop: target step '${target}' is disabled`,
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }

  return steps.map((step) => ({ ...step }));
}

export function normalizeSidekickSteps(payload: unknown): {
  steps: SidekickStep[];
  warnings: string[];
} {
  if (payload === undefined || payload === null) {
    return {
      steps: createDefaultSidekickSteps(),
      warnings: ["sidekick.steps missing; using default workflow"],
    };
  }

  try {
    return {
      steps: parseSidekickSteps(payload),
      warnings: [],
    };
  } catch (error) {
    return {
      steps: createDefaultSidekickSteps(),
      warnings: [
        `invalid sidekick.steps; using default workflow (${formatErrorMessage(error)})`,
      ],
    };
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(issues: z.ZodIssue[]) {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
