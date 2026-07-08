import type { ResearchRunId } from "@idea-finder/core";
import type { LLMProvider } from "@idea-finder/llm";

/** Embed / cluster / extract / score boundary. Implementation deferred. */
export interface IntelligencePipelineDeps {
  readonly llm: LLMProvider;
}

export interface IntelligencePipeline {
  run(runId: ResearchRunId): Promise<void>;
}

export function createIntelligencePipeline(_deps: IntelligencePipelineDeps): IntelligencePipeline {
  return {
    async run(_runId: ResearchRunId): Promise<void> {
      // Wave 1 scaffold — implementation in a later task.
    },
  };
}
