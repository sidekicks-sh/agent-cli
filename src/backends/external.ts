import { z } from "zod";

import { runProcess } from "./process";
import type {
  BackendAdapter,
  BackendFactoryOptions,
  BackendKind,
  BackendRunContext,
  BackendTaskInput,
  BackendTaskResult,
} from "./types";

const DEFAULT_LOG_BATCH_SIZE = 20;

const backendTaskInputSchema = z.object({
  repoPath: z.string().trim().min(1, "repoPath must be a non-empty string"),
  instructions: z
    .string()
    .trim()
    .min(1, "instructions must be a non-empty string"),
  systemPrompt: z.string().optional(),
});

export function createExternalBackendAdapter(
  kind: Exclude<BackendKind, "internal">,
  options: BackendFactoryOptions = {},
): BackendAdapter {
  const logBatchSize = parseLogBatchSize(options.logBatchSize);
  return {
    kind,
    runTask: async (input, context) =>
      runExternalTask(kind, input, context, logBatchSize),
  };
}

async function runExternalTask(
  kind: Exclude<BackendKind, "internal">,
  rawInput: BackendTaskInput,
  context: BackendRunContext | undefined,
  logBatchSize: number,
): Promise<BackendTaskResult> {
  let input: BackendTaskInput;
  try {
    input = backendTaskInputSchema.parse(rawInput);
  } catch (error) {
    return asValidationFailure(kind, error);
  }

  const lineBatcher = createLogBatcher(kind, context, logBatchSize);
  const invocation = buildExternalInvocation(kind, input);

  lineBatcher.push(
    "internal",
    `starting backend command: ${invocation.command}`,
  );

  const result = await runProcess(invocation.command, invocation.args, {
    cwd: input.repoPath,
    env: context?.env ?? process.env,
    stdin: invocation.stdin,
    onStdoutLine: (line) => lineBatcher.push("stdout", line),
    onStderrLine: (line) => lineBatcher.push("stderr", line),
  });

  lineBatcher.flush();

  if (result.spawnError) {
    return {
      backend: kind,
      success: false,
      summary: `${kind} failed to start`,
      output: collectOutput(result.stdout, result.stderr),
      exitCode: result.exitCode,
      error: result.spawnError,
    };
  }

  if (result.exitCode !== 0) {
    return {
      backend: kind,
      success: false,
      summary: `${kind} exited with code ${result.exitCode ?? "unknown"}`,
      output: collectOutput(result.stdout, result.stderr),
      exitCode: result.exitCode,
      error:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.exitCode}`,
    };
  }

  const combinedOutput = collectOutput(result.stdout, result.stderr);
  return {
    backend: kind,
    success: true,
    summary: `${kind} task execution complete`,
    output: combinedOutput,
    exitCode: result.exitCode,
  };
}

function buildExternalInvocation(
  kind: Exclude<BackendKind, "internal">,
  input: BackendTaskInput,
) {
  const withSystemPrompt = createPromptWithSystem(
    input.instructions,
    input.systemPrompt,
  );

  switch (kind) {
    case "codex":
      return {
        command: "codex",
        args: ["exec", "--yolo"],
        stdin: withSystemPrompt,
      };
    case "opencode":
      return {
        command: "opencode",
        args: ["run", withSystemPrompt],
      };
    case "claude": {
      const args = ["--dangerously-skip-permissions", "-p"];
      if (input.systemPrompt && input.systemPrompt.trim().length > 0) {
        args.push("--system-prompt", input.systemPrompt);
      }

      return {
        command: "claude",
        args,
        stdin: input.instructions,
      };
    }
  }
}

function parseLogBatchSize(value: number | undefined) {
  const parsed = z.number().int().positive().safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return DEFAULT_LOG_BATCH_SIZE;
}

function createPromptWithSystem(instructions: string, systemPrompt?: string) {
  if (!systemPrompt || systemPrompt.trim() === "") {
    return instructions;
  }

  return `<system>\n${systemPrompt}\n</system>\n\n${instructions}`;
}

function collectOutput(stdout: string, stderr: string) {
  const out = stdout.trim();
  const err = stderr.trim();
  if (out.length > 0 && err.length > 0) {
    return `${out}\n${err}`.trim();
  }
  return out || err;
}

function createLogBatcher(
  backend: BackendKind,
  context: BackendRunContext | undefined,
  batchSize: number,
) {
  const buffers: Record<"stdout" | "stderr" | "internal", string[]> = {
    stdout: [],
    stderr: [],
    internal: [],
  };

  const emit = (stream: "stdout" | "stderr" | "internal", lines: string[]) => {
    if (!context?.onLog || lines.length === 0) {
      return;
    }

    context.onLog({
      backend,
      stream,
      message: lines.join("\n"),
      timestamp: new Date().toISOString(),
    });
  };

  const flushStream = (stream: "stdout" | "stderr" | "internal") => {
    if (buffers[stream].length === 0) {
      return;
    }

    emit(stream, buffers[stream]);
    buffers[stream] = [];
  };

  return {
    push(stream: "stdout" | "stderr" | "internal", line: string) {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) {
        return;
      }

      buffers[stream].push(trimmed);
      if (buffers[stream].length >= batchSize) {
        flushStream(stream);
      }
    },
    flush() {
      flushStream("stdout");
      flushStream("stderr");
      flushStream("internal");
    },
  };
}

function asValidationFailure(
  kind: BackendKind,
  error: unknown,
): BackendTaskResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    backend: kind,
    success: false,
    summary: `invalid backend task input for ${kind}`,
    output: "",
    exitCode: null,
    error: message,
  };
}
