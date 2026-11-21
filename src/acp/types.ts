// The subset of ACP v1 that pi-antigravity uses. Fields are optional where
// agy versions differ; code reads them defensively.

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: Record<string, unknown>;
    _meta?: { antigravity?: { tier?: boolean; systemPrompt?: { append?: boolean } } };
  };
  agentInfo?: { name?: string; version?: string };
  authMethods?: { id: string; name: string; description?: string }[];
}

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: "select" | string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface NewSessionResult {
  sessionId: string;
  models?: { availableModels: { modelId: string; name: string }[]; currentModelId?: string };
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
  configOptions?: ConfigOption[];
  _meta?: { antigravity?: { tier?: { name?: string; id?: string } } };
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } };

export interface PromptResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;
  usage?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ContentChunk {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string };
}

export interface ToolCallContent {
  type: "content" | "diff" | "terminal" | string;
  content?: ContentChunk;
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}

export interface ToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | string;
  content?: ToolCallContent[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentChunk }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentChunk }
  | { sessionUpdate: "user_message_chunk"; content: ContentChunk }
  | ({ sessionUpdate: "tool_call" } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "plan"; entries: { content: string; status?: string; priority?: string }[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: { name: string; description?: string }[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions?: ConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null }
  | { sessionUpdate: "usage_update"; used?: number; size?: number; [k: string]: unknown }
  | { sessionUpdate: string; [k: string]: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallFields;
  options: PermissionOption[];
}

export type PermissionResponse = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };
