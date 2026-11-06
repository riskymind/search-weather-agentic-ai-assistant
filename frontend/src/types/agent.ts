/**
 * Backend API contract.
 *
 * Mirrors the Pydantic models in `backend/app/schemas/` (agent.py, tools.py, common.py).
 * Keep the two in sync: any change to those schemas must be reflected here.
 */

/** `MAX_MESSAGE_CHARS` in backend/app/schemas/agent.py */
export const MAX_MESSAGE_CHARS = 4000;

// --- Tool outputs (schemas/tools.py) -------------------------------------------------

export type ToolErrorCode = "invalid_input" | "city_not_found" | "not_configured" | "provider_error" | "timeout";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
}

export interface WeatherData {
  kind: "weather";
  city: string;
  country: string;
  region: string | null;
  temperature_c: number;
  feels_like_c: number | null;
  description: string;
  humidity: number;
  wind_speed_kmh: number;
  observation_time: string;
  local_time: string | null;
  icon_url: string | null;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
}

export interface SearchResults {
  kind: "search";
  query: string;
  results: SearchResult[];
}

export type ToolData = WeatherData | SearchResults;

// --- Agent request/response (schemas/agent.py) -----------------------------------------

/** Tool names registered by the backend agent. Other names may appear if tools are added. */
export type KnownToolName = "tavily_search" | "weather";

export type ToolStatus = "running" | "completed" | "failed";

export interface ToolEvent {
  id: string;
  tool: string;
  status: ToolStatus;
  input: Record<string, unknown>;
  summary: string;
  data: ToolData | null;
  error: ToolError | null;
}

export interface AgentQueryRequest {
  message: string;
  /** Session ID from a previous response; null/omitted starts a new session. */
  session_id?: string | null;
}

export interface AgentQueryResponse {
  session_id: string;
  is_new_session: boolean;
  answer: string;
  tool_events: ToolEvent[];
}

// --- Common (schemas/common.py) ------------------------------------------------------

export interface HealthResponse {
  status: "healthy";
  service: string;
  version: string;
  environment: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: Array<Record<string, unknown>>;
}

export interface ErrorResponse {
  error: ErrorBody;
}

// --- Server-Sent Events (schemas/agent.py, POST /api/v1/agent/stream) ------------------
// Each frame is `event: <name>` + JSON `data:`; the JSON repeats the name in `event`.

export interface SessionEvent {
  event: "session";
  session_id: string;
  is_new_session: boolean;
}

export interface StatusEvent {
  event: "status";
  stage: "analyzing" | "preparing_answer";
}

export interface ToolStartEvent {
  event: "tool_start";
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolEndEvent extends ToolEvent {
  event: "tool_end";
}

/** A chunk of the current answer draft. Text received before a `tool_start` is preamble, not answer. */
export interface TokenEvent {
  event: "token";
  delta: string;
}

/** Terminal success. `answer` is authoritative and replaces any streamed draft. */
export interface DoneEvent extends AgentQueryResponse {
  event: "done";
}

/** Terminal failure. */
export interface ErrorEvent {
  event: "error";
  code: string;
  message: string;
}

export type StreamEvent =
  | SessionEvent
  | StatusEvent
  | ToolStartEvent
  | ToolEndEvent
  | TokenEvent
  | DoneEvent
  | ErrorEvent;

export type StreamEventName = StreamEvent["event"];

export const STREAM_EVENT_NAMES: ReadonlySet<StreamEventName> = new Set<StreamEventName>([
  "session",
  "status",
  "tool_start",
  "tool_end",
  "token",
  "done",
  "error",
]);
