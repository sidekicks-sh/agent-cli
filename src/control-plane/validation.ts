import { z } from "zod";

import type { ReservedTask, SidekickRegistration } from "./types";

const nonEmptyString = z.string().trim().min(1, "must be a non-empty string");

const registrationPayloadSchema = z
  .object({
    id: z.string().optional(),
    name: nonEmptyString.optional(),
    purpose: nonEmptyString.optional(),
    prompt: z.string().optional(),
  })
  .transform((value) => ({
    id: value.id,
    name: value.name ?? "sidekick",
    purpose: value.purpose ?? "unknown",
    prompt: value.prompt ?? "",
  }));

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

function formatIssues(issues: z.ZodIssue[]) {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
