import { createInternalBackendAdapter } from "../internal";
import { createExternalBackendAdapter } from "./external";
import type {
  BackendAdapter,
  BackendFactoryOptions,
  BackendKind,
} from "./types";

export * from "./types";

export function createBackendAdapter(
  kind: BackendKind,
  options: BackendFactoryOptions = {},
): BackendAdapter {
  switch (kind) {
    case "internal":
      return createInternalBackendAdapter(options);
    case "codex":
    case "claude":
    case "opencode":
      return createExternalBackendAdapter(kind, options);
  }
}
