"use client";

import { useCallback, useState } from "react";

import { ChatHeader } from "@/components/ChatHeader";
import { ChatInput } from "@/components/ChatInput";
import { ChatLayout } from "@/components/ChatLayout";
import { MessageList } from "@/components/MessageList";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { useBackendHealth } from "@/hooks/useBackendHealth";
import { useChat } from "@/hooks/useChat";
import { useConversations } from "@/hooks/useConversations";
import { useTheme } from "@/hooks/useTheme";
import type { StoredState } from "@/lib/storage";

/** Container: wires state hooks to presentational components. Holds no API logic itself. */
interface ChatAppProps {
  initialState?: StoredState;
  /** Shows "Sign out" when the server's access gate is on. */
  accessGateEnabled?: boolean;
}

export default function ChatApp({ initialState, accessGateEnabled = false }: ChatAppProps) {
  const conversations = useConversations(initialState);
  const { active } = conversations;
  const chat = useChat({
    conversation: active,
    createConversation: conversations.createConversation,
    updateConversation: conversations.updateConversation,
  });
  const theme = useTheme();
  const health = useBackendHealth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const streamingHere = chat.isStreaming && chat.streamingConversationId === (active?.id ?? null);
  const streamingElsewhere = chat.isStreaming && !streamingHere;

  const remove = (id: string) => {
    if (chat.streamingConversationId === id) chat.stop();
    conversations.deleteConversation(id);
  };

  const sidebarProps = {
    conversations: conversations.conversations,
    activeId: active?.id ?? null,
    onNewConversation: () => {
      conversations.startNewConversation();
      closeDrawer();
    },
    onSelectConversation: (id: string) => {
      conversations.selectConversation(id);
      closeDrawer();
    },
    onDeleteConversation: remove,
    settings: (
      <SettingsPanel
        theme={theme.preference}
        onThemeChange={theme.setPreference}
        backendStatus={health.status}
        onRecheckBackend={health.recheck}
        onClearAll={() => {
          chat.stop();
          conversations.clearAll();
        }}
        hasConversations={conversations.conversations.length > 0}
        accessGateEnabled={accessGateEnabled}
      />
    ),
  };

  const messages = active?.messages ?? [];

  return (
    <ChatLayout
      sidebar={<Sidebar {...sidebarProps} />}
      drawerSidebar={<Sidebar {...sidebarProps} onClose={closeDrawer} />}
      drawerOpen={drawerOpen}
      onCloseDrawer={closeDrawer}
      header={
        <ChatHeader
          title={active?.title ?? "New conversation"}
          onOpenSidebar={() => setDrawerOpen(true)}
          onClear={active ? () => remove(active.id) : undefined}
        />
      }
    >
      {messages.length === 0 ? (
        <div className="flex flex-1 overflow-y-auto">
          <WelcomeScreen onSelectPrompt={(prompt) => void chat.send(prompt)} disabled={chat.isStreaming} />
        </div>
      ) : (
        <MessageList messages={messages} onRetry={chat.retry} retryDisabled={chat.isStreaming} />
      )}
      <ChatInput
        onSubmit={(message) => void chat.send(message)}
        onStop={chat.stop}
        isStreaming={streamingHere}
        disabled={streamingElsewhere}
      />
    </ChatLayout>
  );
}
