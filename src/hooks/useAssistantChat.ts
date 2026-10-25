// The assistant chat of the signed-in user (state lives in AssistantChatProvider).
import { useAssistantChatContext, type AssistantChat } from '@/contexts/AssistantChatContext';

export type { AssistantChat, ChatError, UiMessage } from '@/contexts/AssistantChatContext';

export function useAssistantChat(): AssistantChat {
  const chat = useAssistantChatContext();
  if (!chat) throw new Error('useAssistantChat must be used within AssistantChatProvider');
  return chat;
}

/** The chat when the assistant is switched on (VITE_ASSISTANT_ENABLED), otherwise null. */
export const useOptionalAssistantChat = (): AssistantChat | null => useAssistantChatContext();
