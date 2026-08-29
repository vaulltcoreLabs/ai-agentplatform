/**
 * Vaulltcore Agent Engine — provider-neutral event model.
 *
 * The engine emits structured events. The future workflow system can persist
 * them, the future UI can stream them, and the future telemetry system can
 * consume them. Names are provider-neutral; no ai-SDK or vendor types leak.
 */

import type { LanguageModelUsage } from "ai";

export type EngineEvent =
  | { type: "agent.started"; runId: string; model: string }
  | { type: "agent.thinking"; runId: string }
  | {
      type: "agent.tool.started";
      runId: string;
      tool: string;
      toolCallId: string;
    }
  | {
      type: "agent.tool.completed";
      runId: string;
      tool: string;
      toolCallId: string;
      durationMs?: number;
    }
  | { type: "agent.subagent.started"; runId: string; role: string }
  | {
      type: "agent.subagent.completed";
      runId: string;
      role: string;
      usage?: LanguageModelUsage;
    }
  | { type: "agent.message.delta"; runId: string; text: string }
  | { type: "agent.message.completed"; runId: string }
  | {
      type: "agent.usage";
      runId: string;
      usage: LanguageModelUsage;
      model: string;
    }
  | { type: "agent.warning"; runId: string; message: string }
  | {
      type: "agent.failed";
      runId: string;
      error: { kind: string; message: string };
    }
  | { type: "agent.completed"; runId: string; usage?: LanguageModelUsage };

export type EngineEventType = EngineEvent["type"];

export function isEngineEvent(value: unknown): value is EngineEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("agent.")
  );
}
