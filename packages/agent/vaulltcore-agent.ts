import type { SandboxSecurityPolicy, SandboxState } from "@vaulltcore/sandbox";
import {
  stepCountIs,
  ToolLoopAgent,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { addCacheControl } from "./context-management";
import {
  type GatewayModelId,
  gateway,
  type ProviderOptionsByProvider,
} from "./models";

import type { SkillMetadata } from "./skills/types";
import { buildSystemPrompt } from "./system-prompt";
import {
  askUserQuestionTool,
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  skillTool,
  taskTool,
  todoWriteTool,
  webFetchTool,
  writeFileTool,
} from "./tools";

export interface AgentModelSelection {
  id: GatewayModelId;
  providerOptionsOverrides?: ProviderOptionsByProvider;
}

export type VaulltcoreAgentModelInput = GatewayModelId | AgentModelSelection;

/**
 * Resolves an agent model selection to a provider-neutral `LanguageModel`.
 * Injected so the engine can swap providers (BYOK, mocks, self-hosted) without
 * changing the runner. The default delegates to the existing `gateway`.
 */
export type VaulltcoreAgentResolveModel = (
  selection: AgentModelSelection,
) => LanguageModel;

export const defaultResolveModel: VaulltcoreAgentResolveModel = (selection) =>
  gateway(selection.id, {
    providerOptionsOverrides: selection.providerOptionsOverrides,
  });

export interface AgentSandboxContext {
  state: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  /**
   * Optional security policy enforced on every tool sandbox operation.
   * Phase 4.4: when present, `getSandbox` wraps the live sandbox so path
   * confinement, command filtering, and file-size ceilings are checked at
   * the tool I/O boundary (see @vaulltcore/sandbox/policy-enforcement).
   */
  securityPolicy?: SandboxSecurityPolicy;
}

const callOptionsSchema = z.object({
  sandbox: z.custom<AgentSandboxContext>(),
  model: z.custom<VaulltcoreAgentModelInput>().optional(),
  subagentModel: z.custom<VaulltcoreAgentModelInput>().optional(),
  customInstructions: z.string().optional(),
  skills: z.custom<SkillMetadata[]>().optional(),
});

export type VaulltcoreAgentCallOptions = z.infer<typeof callOptionsSchema>;

export const defaultModelLabel = "anthropic/claude-opus-4.6" as const;
export const defaultModel = gateway(defaultModelLabel);

function normalizeAgentModelSelection(
  selection: VaulltcoreAgentModelInput | undefined,
  fallbackId: GatewayModelId,
): AgentModelSelection {
  if (!selection) {
    return { id: fallbackId };
  }

  return typeof selection === "string" ? { id: selection } : selection;
}

const tools = {
  todo_write: todoWriteTool,
  read: readFileTool(),
  write: writeFileTool(),
  edit: editFileTool(),
  grep: grepTool(),
  glob: globTool(),
  bash: bashTool(),
  task: taskTool,
  ask_user_question: askUserQuestionTool,
  skill: skillTool,
  web_fetch: webFetchTool,
} satisfies ToolSet;

function buildVaulltcoreAgentInstance(
  resolveModel: VaulltcoreAgentResolveModel,
) {
  return new ToolLoopAgent({
    model: defaultModel,
    instructions: buildSystemPrompt({}),
    tools,
    stopWhen: stepCountIs(1),
    callOptionsSchema,
    prepareStep: ({ messages, model, steps: _steps }) => {
      return {
        messages: addCacheControl({
          messages,
          model,
        }),
      };
    },
    prepareCall: ({ options, ...settings }) => {
      if (!options) {
        throw new Error("Vaulltcore Agent requires call options with sandbox.");
      }

      const mainSelection = normalizeAgentModelSelection(
        options.model,
        defaultModelLabel,
      );
      const subagentSelection = options.subagentModel
        ? normalizeAgentModelSelection(options.subagentModel, defaultModelLabel)
        : undefined;

      const callModel = resolveModel(mainSelection);
      const subagentModel = subagentSelection
        ? resolveModel(subagentSelection)
        : undefined;
      const customInstructions = options.customInstructions;
      const sandbox = options.sandbox;
      const skills = options.skills ?? [];

      const instructions = buildSystemPrompt({
        cwd: sandbox.workingDirectory,
        currentBranch: sandbox.currentBranch,
        customInstructions,
        environmentDetails: sandbox.environmentDetails,
        skills,
        modelId: mainSelection.id,
      });

      return {
        ...settings,
        model: callModel,
        tools: addCacheControl({
          tools: settings.tools ?? tools,
          model: callModel,
        }),
        instructions,
        experimental_context: {
          sandbox,
          skills,
          model: callModel,
          subagentModel,
        },
      };
    },
  });
}

export const vaulltcoreAgent =
  buildVaulltcoreAgentInstance(defaultResolveModel);

export function createVaulltcoreAgent(
  resolveModel: VaulltcoreAgentResolveModel = defaultResolveModel,
) {
  return buildVaulltcoreAgentInstance(resolveModel);
}

export type VaulltcoreAgentInstance = typeof vaulltcoreAgent;
