import { describe, expect, it } from "bun:test";

import {
  ControlPlaneClient,
  parseRegistrationPayload,
  parseReservedTaskPayload,
} from "../src/control-plane";

describe("control-plane validation", () => {
  it("parses registration payload and falls back to default steps", () => {
    const registration = parseRegistrationPayload({
      name: "My Sidekick",
      purpose: "Testing",
      prompt: "Be precise",
    });

    expect(registration.name).toBe("My Sidekick");
    expect(registration.steps.map((step) => step.id)).toEqual([
      "plan",
      "execute",
      "review",
    ]);
    expect(registration.stepConfigWarnings.length).toBe(1);
  });

  it("falls back to default steps when registration steps are invalid", () => {
    const registration = parseRegistrationPayload({
      name: "My Sidekick",
      purpose: "Testing",
      prompt: "Be precise",
      steps: [
        {
          id: "bad id",
          name: "Plan",
          prompt: "Do thing",
          enabled: true,
          onPass: "next",
          onReloop: "self",
        },
      ],
    });

    expect(registration.steps.map((step) => step.id)).toEqual([
      "plan",
      "execute",
      "review",
    ]);
    expect(registration.stepConfigWarnings[0]).toContain(
      "invalid sidekick.steps",
    );
  });

  it("parses a valid reserved task payload", () => {
    const task = parseReservedTaskPayload({
      task_id: "task-1",
      run_id: "run-1",
      task_title: "Fix lint issues",
      repo_url: "git@github.com:acme/repo.git",
      repo_name: "repo",
      base_branch: "main",
      execution_branch: "sidekick/task-1",
      instructions: "Run lint and fix failures",
    });

    expect(task).toEqual({
      taskId: "task-1",
      runId: "run-1",
      taskTitle: "Fix lint issues",
      repoUrl: "git@github.com:acme/repo.git",
      repoName: "repo",
      baseBranch: "main",
      executionBranch: "sidekick/task-1",
      instructions: "Run lint and fix failures",
    });
  });

  it("rejects reserved task payloads with missing required fields", () => {
    expect(() =>
      parseReservedTaskPayload({
        task_id: "task-1",
        run_id: "",
      }),
    ).toThrow("run_id: must be a non-empty string");
  });
});

describe("control-plane client", () => {
  it("returns null when reserve endpoint responds with 204", async () => {
    const client = new ControlPlaneClient({
      baseUrl: "https://example.com/api",
      apiToken: "token",
      fetchImpl: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    const task = await client.reserveTask();
    expect(task).toBeNull();
  });

  it("retries transient failures and emits telemetry", async () => {
    let attempts = 0;
    const telemetryTypes: string[] = [];

    const client = new ControlPlaneClient({
      baseUrl: "https://example.com/api",
      apiToken: "token",
      retryPolicy: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      telemetry: (event) => {
        telemetryTypes.push(event.type);
      },
      fetchImpl: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve(
            new Response("busy", {
              status: 503,
              statusText: "Service Unavailable",
            }),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              task_id: "task-1",
              run_id: "run-1",
              task_title: "Fix lint issues",
              repo_url: "git@github.com:acme/repo.git",
              repo_name: "repo",
              base_branch: "main",
              execution_branch: "sidekick/task-1",
              instructions: "Run lint and fix failures",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        );
      },
    });

    const task = await client.reserveTask();
    expect(task?.taskId).toBe("task-1");
    expect(attempts).toBe(2);
    expect(telemetryTypes.includes("retry")).toBe(true);
  });

  it("sends task status payload in expected shape", async () => {
    const calls: Array<{ url: string; body: Record<string, string> }> = [];

    const client = new ControlPlaneClient({
      baseUrl: "https://example.com/api",
      apiToken: "token",
      fetchImpl: (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const bodyRaw = init?.body;
        if (typeof bodyRaw !== "string") {
          throw new Error("Expected JSON string request body in test");
        }

        calls.push({
          url,
          body: JSON.parse(bodyRaw) as Record<string, string>,
        });

        return Promise.resolve(new Response("", { status: 200 }));
      },
    });

    await client.sendTaskStatus({
      id: "task-1",
      runId: "run-1",
      status: "running",
      message: "started",
      resultUrl: "",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.com/api/sidekick/task/status");
    expect(calls[0].body).toEqual({
      id: "task-1",
      runId: "run-1",
      status: "running",
      message: "started",
      resultUrl: "",
    });
  });

  it("sends task artifact payload in expected shape", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    const client = new ControlPlaneClient({
      baseUrl: "https://example.com/api",
      apiToken: "token",
      fetchImpl: (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const bodyRaw = init?.body;
        if (typeof bodyRaw !== "string") {
          throw new Error("Expected JSON string request body in test");
        }

        calls.push({
          url,
          body: JSON.parse(bodyRaw) as Record<string, unknown>,
        });

        return Promise.resolve(new Response("", { status: 200 }));
      },
    });

    await client.sendTaskArtifact({
      id: "task-1",
      runId: "run-1",
      type: "step.plan",
      payload: {
        attempt: 1,
        decision: "pass",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://example.com/api/sidekick/task/artifact",
    );
    expect(calls[0].body).toEqual({
      id: "task-1",
      runId: "run-1",
      type: "step.plan",
      payload: {
        attempt: 1,
        decision: "pass",
      },
    });
  });
});
