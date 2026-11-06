/**
 * Browser-side API configuration.
 *
 * The browser only calls this app's own same-origin route handlers under `/api`. They proxy
 * to the FastAPI backend on the server, where the backend URL (BACKEND_API_URL) and its
 * access key (BACKEND_API_ACCESS_KEY) live. Neither is ever part of the browser bundle.
 */

export const API_BASE_PATH = "/api";

export const API_PATHS = {
  health: `${API_BASE_PATH}/health`,
  query: `${API_BASE_PATH}/agent/query`,
  stream: `${API_BASE_PATH}/agent/stream`,
} as const;
