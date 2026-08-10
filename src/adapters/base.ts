import type { AgentKind, AgentResult, AgentUsage, ContextPacket, RunMode } from "../types.js";

export interface AdapterOptions {
  root: string;
  temporaryDir: string;
  mode: RunMode;
  environment: NodeJS.ProcessEnv;
  model?: string;
  maxOutputTokens: number;
}

export interface AdapterResponse {
  result: AgentResult;
  nativeOutput: string;
  nativeFileName: string;
  diagnostics?: string;
  usage?: AgentUsage;
  model?: string;
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
