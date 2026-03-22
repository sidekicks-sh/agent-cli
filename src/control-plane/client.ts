import {
  parseRegistrationPayload,
  parseReservedTaskPayload,
} from "./validation";
import type {
  ControlPlaneClientOptions,
  ControlPlaneTelemetryEvent,
  HeartbeatInput,
  RegisterSidekickInput,
  ReservedTask,
  RetryPolicy,
  SidekickRegistration,
  TaskArtifactInput,
  TaskLogInput,
  TaskStatusInput,
} from "./types";

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 3_000,
};

const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

interface RequestOptions {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  parseJson?: boolean;
  allowNoContent?: boolean;
}

interface RequestErrorDetails {
  status: number;
  statusText: string;
  bodyText: string;
  transient: boolean;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fetchImpl: NonNullable<
    ControlPlaneClientOptions["fetchImpl"]
  >;
  private readonly retryPolicy: RetryPolicy;
  private readonly telemetry?: (event: ControlPlaneTelemetryEvent) => void;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retryPolicy,
    };
    this.telemetry = options.telemetry;
  }

  async registerSidekick(
    input: RegisterSidekickInput,
  ): Promise<SidekickRegistration> {
    const payload = await this.request({
      method: "POST",
      path: "/sidekick/register",
      body: {
        agent: input.agent,
        hostname: input.hostname,
        status: input.status,
      },
      parseJson: true,
    });

    return parseRegistrationPayload(payload);
  }

  async reserveTask(): Promise<ReservedTask | null> {
    const payload = await this.request({
      method: "POST",
      path: "/sidekick/task/reserve",
      body: {},
      parseJson: true,
      allowNoContent: true,
    });

    if (payload === null) {
      return null;
    }

    return parseReservedTaskPayload(payload);
  }

  async sendHeartbeat(input: HeartbeatInput): Promise<void> {
    await this.request({
      method: "POST",
      path: "/sidekick/heartbeat",
      body: {
        status: input.status,
      },
    });
  }

  async sendTaskStatus(input: TaskStatusInput): Promise<void> {
    await this.request({
      method: "POST",
      path: "/sidekick/task/status",
      body: {
        id: input.id,
        runId: input.runId,
        status: input.status,
        message: input.message,
        resultUrl: input.resultUrl,
      },
    });
  }

  async sendTaskLog(input: TaskLogInput): Promise<void> {
    await this.request({
      method: "POST",
      path: "/sidekick/task/log",
      body: {
        id: input.id,
        runId: input.runId,
        message: input.message,
      },
    });
  }

  async sendTaskArtifact(input: TaskArtifactInput): Promise<void> {
    await this.request({
      method: "POST",
      path: "/sidekick/task/artifact",
      body: {
        id: input.id,
        runId: input.runId,
        type: input.type,
        payload: input.payload,
      },
    });
  }

  private async request(options: RequestOptions): Promise<unknown> {
    const url = new URL(
      trimLeadingSlash(options.path),
      this.baseUrl,
    ).toString();
    const requestId = createRequestId();

    let attempt = 1;
    while (attempt <= this.retryPolicy.maxAttempts) {
      this.emitTelemetry({
        type: "request",
        requestId,
        method: options.method,
        url,
        attempt,
      });

      const startedAt = Date.now();

      try {
        const response = await this.fetchImpl(url, {
          method: options.method,
          headers: {
            authorization: `Bearer ${this.apiToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(options.body),
        });

        this.emitTelemetry({
          type: "response",
          requestId,
          method: options.method,
          url,
          attempt,
          status: response.status,
          elapsedMs: Date.now() - startedAt,
        });

        if (response.status === 204 && options.allowNoContent) {
          return null;
        }

        if (!response.ok) {
          const details = await this.readRequestErrorDetails(response);
          const shouldRetry =
            details.transient && attempt < this.retryPolicy.maxAttempts;

          if (!shouldRetry) {
            throw new Error(
              `Control plane request failed (${response.status} ${response.statusText}) on ${options.path}: ${details.bodyText || "no response body"}`,
            );
          }

          const backoffMs = this.computeBackoff(attempt);
          this.emitTelemetry({
            type: "retry",
            requestId,
            method: options.method,
            url,
            attempt,
            reason: `http_${details.status}`,
            backoffMs,
          });
          await sleep(backoffMs);
          attempt += 1;
          continue;
        }

        if (!options.parseJson) {
          return null;
        }

        const text = await response.text();
        if (text.trim() === "") {
          return null;
        }

        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new Error(
            `Control plane request returned invalid JSON on ${options.path}`,
          );
        }
      } catch (error) {
        if (isRequestError(error)) {
          throw error;
        }

        const shouldRetry = attempt < this.retryPolicy.maxAttempts;
        if (!shouldRetry) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.emitTelemetry({
            type: "error",
            requestId,
            method: options.method,
            url,
            attempt,
            reason: message,
          });
          throw new Error(
            `Control plane request failed on ${options.path}: ${message}`,
          );
        }

        const backoffMs = this.computeBackoff(attempt);
        this.emitTelemetry({
          type: "retry",
          requestId,
          method: options.method,
          url,
          attempt,
          reason: "network_error",
          backoffMs,
        });
        await sleep(backoffMs);
        attempt += 1;
      }
    }

    throw new Error(
      `Control plane request exhausted retries on ${options.path} after ${this.retryPolicy.maxAttempts} attempts`,
    );
  }

  private async readRequestErrorDetails(
    response: Response,
  ): Promise<RequestErrorDetails> {
    const bodyText = (await response.text().catch(() => "")).trim();
    return {
      status: response.status,
      statusText: response.statusText,
      bodyText,
      transient: TRANSIENT_STATUS_CODES.has(response.status),
    };
  }

  private computeBackoff(attempt: number) {
    const exponential = this.retryPolicy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.retryPolicy.maxDelayMs);
  }

  private emitTelemetry(event: ControlPlaneTelemetryEvent) {
    if (!this.telemetry) {
      return;
    }

    try {
      this.telemetry(event);
    } catch {
      // Telemetry must never break daemon runtime.
    }
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function trimLeadingSlash(path: string) {
  return path.startsWith("/") ? path.slice(1) : path;
}

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRequestError(error: unknown) {
  return (
    error instanceof Error && error.message.startsWith("Control plane request")
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
