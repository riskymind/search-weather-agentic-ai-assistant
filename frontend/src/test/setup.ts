import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Server tests (route handlers, proxy) run in the node environment, without a DOM.
const hasDom = typeof window !== "undefined";

// jsdom has no matchMedia; the theme hook needs it.
if (hasDom && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

afterEach(() => {
  if (!hasDom) return;
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});
