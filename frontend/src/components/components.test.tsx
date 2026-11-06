import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AgentActivity } from "@/components/AgentActivity";
import { ChatInput } from "@/components/ChatInput";
import { ErrorMessage } from "@/components/ErrorMessage";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { MarkdownContent } from "@/components/MarkdownContent";
import { SearchResultCard } from "@/components/SearchResultCard";
import { SettingsPanel } from "@/components/SettingsPanel";
import { SUGGESTED_PROMPTS } from "@/components/SuggestedPrompts";
import { WeatherCard } from "@/components/WeatherCard";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { applyStreamEvent, newAssistantMessage } from "@/lib/chat";
import { multiToolTurn, SEARCH, WEATHER } from "@/test/fixtures";
import { MAX_MESSAGE_CHARS } from "@/types/agent";

describe("WelcomeScreen", () => {
  it("introduces the assistant and lists the four suggested prompts", async () => {
    const onSelect = vi.fn();
    render(<WelcomeScreen onSelectPrompt={onSelect} />);
    expect(screen.getByRole("heading", { level: 1, name: "What would you like to know?" })).toBeInTheDocument();
    const prompts = within(screen.getByRole("list", { name: "Suggested questions" })).getAllByRole("button");
    expect(prompts.map((b) => b.textContent)).toEqual(SUGGESTED_PROMPTS.map((p) => p.text));
    expect(SUGGESTED_PROMPTS.map((p) => p.text)).toEqual([
      "What's the current weather in Lagos?",
      "Find the latest technology news.",
      "Find the capital of Kenya and its current weather.",
      "Research the latest developments in artificial intelligence.",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Find the capital of Kenya and its current weather." }));
    expect(onSelect).toHaveBeenCalledWith("Find the capital of Kenya and its current weather.");
  });

  it("disables prompts while a reply is in progress", () => {
    render(<WelcomeScreen onSelectPrompt={vi.fn()} disabled />);
    screen.getAllByRole("button").forEach((b) => expect(b).toBeDisabled());
  });
});

describe("ChatInput", () => {
  const setup = (props: Partial<Parameters<typeof ChatInput>[0]> = {}) => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<ChatInput onSubmit={onSubmit} onStop={onStop} isStreaming={false} {...props} />);
    return { onSubmit, onStop, input: screen.getByRole("textbox", { name: "Message" }) };
  };

  it("submits on Enter and clears the input", async () => {
    const { onSubmit, input } = setup();
    await userEvent.type(input, "  Weather in Lagos?  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Weather in Lagos?");
    expect(input).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter instead of submitting", async () => {
    const { onSubmit, input } = setup();
    await userEvent.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue("line one\nline two");
  });

  it("does not submit empty or whitespace-only messages", async () => {
    const { onSubmit, input } = setup();
    await userEvent.type(input, "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("shows a stop button while streaming and blocks sending", async () => {
    const { onSubmit, onStop, input } = setup({ isStreaming: true });
    await userEvent.type(input, "next question{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalled();
  });

  it("flags messages over the length limit", async () => {
    const { onSubmit, input } = setup();
    await userEvent.click(input);
    await userEvent.paste("x".repeat(MAX_MESSAGE_CHARS + 1));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(`${(MAX_MESSAGE_CHARS + 1).toLocaleString()} / ${MAX_MESSAGE_CHARS.toLocaleString()}`)).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("WeatherCard", () => {
  it("renders location, temperature, conditions and readings", () => {
    render(<WeatherCard data={WEATHER} />);
    const card = screen.getByRole("article", { name: "Current weather in Nairobi" });
    expect(within(card).getByRole("heading", { name: "Nairobi" })).toBeInTheDocument();
    expect(card).toHaveTextContent("Nairobi Area, Kenya");
    expect(card).toHaveTextContent("22°C");
    expect(card).toHaveTextContent("Partly cloudy");
    expect(card).toHaveTextContent("Humidity64%");
    expect(card).toHaveTextContent("Wind13 km/h");
    expect(card).toHaveTextContent("Feels like23°C");
    expect(card).toHaveTextContent("Observed01:45 PM");
  });

  it("handles a missing feels-like value", () => {
    render(<WeatherCard data={{ ...WEATHER, feels_like_c: null, region: null, local_time: null }} />);
    expect(screen.getByRole("article")).toHaveTextContent("Feels like—");
  });
});

describe("SearchResultCard", () => {
  it("links safely to the source in a new tab", () => {
    render(<SearchResultCard result={SEARCH.results[0]!} />);
    const link = screen.getByRole("link", { name: /Nairobi - Wikipedia/ });
    expect(link).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Nairobi");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("en.wikipedia.org");
    expect(link).toHaveTextContent("Nairobi is the capital");
  });

  it("never renders unsafe URLs as links", () => {
    render(<SearchResultCard result={{ title: "Bad", url: "javascript:alert(1)", content: "", score: null }} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Bad")).toBeInTheDocument();
  });
});

describe("MarkdownContent", () => {
  it("renders formatting and safe external links, but no raw HTML or unsafe links", () => {
    render(
      <MarkdownContent
        content={'**Abuja** is the capital. See [Wikipedia](https://en.wikipedia.org/wiki/Abuja) and [bad](javascript:alert(1)).\n\n<img src=x onerror="alert(1)">'}
      />,
    );
    expect(screen.getByText("Abuja").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "Wikipedia" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("AgentActivity", () => {
  it("shows live tool progress while streaming, then collapses to a summary", async () => {
    const events = multiToolTurn();
    const partial = events.slice(0, 7).reduce(applyStreamEvent, newAssistantMessage());
    const { rerender } = render(<AgentActivity message={partial} />);
    const list = screen.getByRole("list", { name: "Assistant activity" });
    expect(within(list).getByText("Searched the web")).toBeInTheDocument();
    expect(within(list).getByText("Retrieving weather information")).toBeInTheDocument();
    expect(within(list).getByText("Nairobi")).toBeInTheDocument();

    const done = events.reduce(applyStreamEvent, newAssistantMessage());
    rerender(<AgentActivity message={done} />);
    const toggle = screen.getByRole("button", { name: /Searched the web and checked the weather/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(within(screen.getByRole("list", { name: "Assistant activity" })).getByText("Completed")).toBeInTheDocument();
  });
});

describe("ErrorMessage and LoadingIndicator", () => {
  it("explains rate limiting with the retry delay and offers a retry", async () => {
    const onRetry = vi.fn();
    render(<ErrorMessage error={{ code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 30 }} onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Too many requests");
    expect(alert).toHaveTextContent("Try again in 30 seconds");
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("announces loading politely", () => {
    render(<LoadingIndicator label="Analyzing your request" />);
    expect(screen.getByRole("status")).toHaveTextContent("Analyzing your request");
  });
});

describe("Access controls", () => {
  it("offers to sign in again when the access session expired, instead of retrying", () => {
    render(
      <ErrorMessage error={{ code: "access_required", message: "Enter an access code.", retryAfterSeconds: null }} onRetry={vi.fn()} />,
    );
    expect(screen.getByText("Your access has expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/access");
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("shows Sign out only when the access gate is on", async () => {
    const props = {
      theme: "system" as const,
      onThemeChange: vi.fn(),
      backendStatus: "online" as const,
      onRecheckBackend: vi.fn(),
      onClearAll: vi.fn(),
      hasConversations: false,
    };
    const { unmount } = render(<SettingsPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    unmount();

    render(<SettingsPanel {...props} accessGateEnabled />);
    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    const signOut = screen.getByRole("button", { name: /sign out/i });
    expect(signOut.closest("form")).toHaveAttribute("action", "/api/access/logout");
    expect(signOut.closest("form")).toHaveAttribute("method", "post");
  });
});
