import { resolve } from "node:path";

import { z } from "zod";

import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  type BackendKind,
} from "../backends";

const DEFAULT_CONTROL_PLANE_URL = "https://sidekicks.sh/api";
const DEFAULT_SIDEKICK_ID = "sidekick-001";
const DEFAULT_REPOS_DIR = "./repos";
const DEFAULT_PID_FILE = "./sidekick.pid";
const DEFAULT_LOG_FILE = "./sidekick.log";
const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_LOG_BATCH_SIZE = 20;

const nonEmptyString = z.string().trim().min(1, "must be a non-empty string");

const envConfigSchema = z
  .object({
    SIDEKICK_CONTROL_PLANE_URL: nonEmptyString.default(
      DEFAULT_CONTROL_PLANE_URL,
    ),
    SIDEKICK_API_TOKEN: nonEmptyString.default("mock-token"),
    SIDEKICK_ID: nonEmptyString.default(DEFAULT_SIDEKICK_ID),
    SIDEKICK_REPOS_DIR: nonEmptyString.default(DEFAULT_REPOS_DIR),
    SIDEKICK_POLL_INTERVAL: positiveIntegerFromEnv(
      "SIDEKICK_POLL_INTERVAL",
      DEFAULT_POLL_INTERVAL_SECONDS,
    ),
    SIDEKICK_AGENT: z.enum(SUPPORTED_BACKENDS).default(DEFAULT_BACKEND),
    SIDEKICK_PID_FILE: nonEmptyString.default(DEFAULT_PID_FILE),
    SIDEKICK_LOG_FILE: nonEmptyString.default(DEFAULT_LOG_FILE),
    SIDEKICK_LOG_BATCH_SIZE: positiveIntegerFromEnv(
      "SIDEKICK_LOG_BATCH_SIZE",
      DEFAULT_LOG_BATCH_SIZE,
    ),
  })
  .passthrough();

const configOverridesSchema = z
  .object({
    logFile: nonEmptyString.optional(),
    pidFile: nonEmptyString.optional(),
  })
  .default({});

export interface SidekickConfig {
  controlPlaneUrl: string;
  apiToken: string;
  sidekickId: string;
  reposDir: string;
  pollIntervalSeconds: number;
  agent: BackendKind;
  pidFile: string;
  logFile: string;
  logBatchSize: number;
}

interface ConfigOverrides {
  logFile?: string;
  pidFile?: string;
}

export function readConfig(
  env: NodeJS.ProcessEnv,
  overrides?: ConfigOverrides,
): SidekickConfig {
  const parsedEnvResult = envConfigSchema.safeParse(env);
  if (!parsedEnvResult.success) {
    throw new Error(
      `Invalid environment config: ${formatIssues(parsedEnvResult.error.issues)}`,
    );
  }

  const parsedOverridesResult = configOverridesSchema.safeParse(overrides);
  if (!parsedOverridesResult.success) {
    throw new Error(
      `Invalid config overrides: ${formatIssues(parsedOverridesResult.error.issues)}`,
    );
  }

  const parsedEnv = parsedEnvResult.data;
  const parsedOverrides = parsedOverridesResult.data;

  return {
    controlPlaneUrl: parsedEnv.SIDEKICK_CONTROL_PLANE_URL,
    apiToken: parsedEnv.SIDEKICK_API_TOKEN,
    sidekickId: parsedEnv.SIDEKICK_ID,
    reposDir: resolve(parsedEnv.SIDEKICK_REPOS_DIR),
    pollIntervalSeconds: parsedEnv.SIDEKICK_POLL_INTERVAL,
    agent: parsedEnv.SIDEKICK_AGENT,
    pidFile: resolve(parsedOverrides.pidFile ?? parsedEnv.SIDEKICK_PID_FILE),
    logFile: resolve(parsedOverrides.logFile ?? parsedEnv.SIDEKICK_LOG_FILE),
    logBatchSize: parsedEnv.SIDEKICK_LOG_BATCH_SIZE,
  };
}

function positiveIntegerFromEnv(name: string, fallback: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") {
        return fallback;
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be a positive integer`,
        });
        return z.NEVER;
      }

      return parsed;
    });
}

function formatIssues(issues: z.ZodIssue[]) {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
