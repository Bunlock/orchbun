import type { AgentKind, AgentResult, AgentUsage, ContextPacket, RunMode } from "../types.js";

export interface AdapterOptions {
  controlRoot: string;
  root: string;
  temporaryDir: string;
  mode: RunMode;
  environment: NodeJS.ProcessEnv;
  model?: string;
  maxOutputTokens: number;
  /** Continue this provider session instead of starting a new one. */
  resumeSessionId?: string;
}

export interface AdapterResponse {
  result: AgentResult;
  nativeOutput: string;
  nativeFileName: string;
  diagnostics?: string;
  usage?: AgentUsage;
  model?: string;
  sessionId?: string;
}

export class AdapterExecutionError extends Error {
  constructor(
    message: string,
    readonly nativeOutput: string,
    readonly nativeFileName: string,
  ) {
    super(message);
    this.name = "AdapterExecutionError";
  }
}

export interface AgentAdapter {
  kind: AgentKind;
  execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse>;
}
