"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createId, titleFromMessage, type Conversation } from "@/lib/chat";
import { clearStoredState, loadState, MAX_STORED_CONVERSATIONS, saveState, type StoredState } from "@/lib/storage";

const SAVE_DELAY_MS = 250;

export interface ConversationsApi {
  conversations: Conversation[];
  active: Conversation | null;
  createConversation: (firstMessage: string) => string;
  updateConversation: (id: string, update: (conversation: Conversation) => Conversation) => void;
  selectConversation: (id: string) => void;
  startNewConversation: () => void;
  deleteConversation: (id: string) => void;
  clearAll: () => void;
}

/**
 * Conversation list persisted to localStorage (this browser only).
 * Must run client-side only: the initial state is read synchronously from storage.
 */
export function useConversations(initialState?: StoredState): ConversationsApi {
  const [state, setState] = useState<StoredState>(() => initialState ?? loadState());

  // Debounced persistence (streaming updates many times per second).
  useEffect(() => {
    const timer = window.setTimeout(() => saveState(state), SAVE_DELAY_MS);
    const flush = () => saveState(state);
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [state]);

  const conversations = useMemo(
    () => [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations],
  );
  const active = state.conversations.find((c) => c.id === state.activeId) ?? null;

  const createConversation = useCallback((firstMessage: string): string => {
    const id = createId();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: titleFromMessage(firstMessage),
      sessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    setState((s) => ({
      conversations: [conversation, ...s.conversations].slice(0, MAX_STORED_CONVERSATIONS),
      activeId: id,
    }));
    return id;
  }, []);

  const updateConversation = useCallback((id: string, update: (conversation: Conversation) => Conversation) => {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === id ? { ...update(c), updatedAt: Date.now() } : c)),
    }));
  }, []);

  const selectConversation = useCallback((id: string) => setState((s) => ({ ...s, activeId: id })), []);
  const startNewConversation = useCallback(() => setState((s) => ({ ...s, activeId: null })), []);

  const deleteConversation = useCallback((id: string) => {
    setState((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  }, []);

  const clearAll = useCallback(() => {
    clearStoredState();
    setState({ conversations: [], activeId: null });
  }, []);

  return {
    conversations,
    active,
    createConversation,
    updateConversation,
    selectConversation,
    startNewConversation,
    deleteConversation,
    clearAll,
  };
}
