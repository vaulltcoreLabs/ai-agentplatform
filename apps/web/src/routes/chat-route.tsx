import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { RequireAuth } from "@/src/auth-guard";
import { useSession } from "@/hooks/use-session";
import type { Session, Chat } from "@/lib/db/schema";
import type { WebAgentUIMessage } from "@/app/types";
import { DiffsProvider } from "@/components/diffs-provider";
import { SessionChatProvider } from "@/app/sessions/[sessionId]/chats/[chatId]/session-chat-context";
import { SessionChatContent } from "@/app/sessions/[sessionId]/chats/[chatId]/session-chat-content";
import { getInitialIsOnlyChatInSession } from "@/app/sessions/[sessionId]/chats/[chatId]/only-chat-in-session";

interface ChatResponse {
  chat: Chat;
  isStreaming: boolean;
  messages: WebAgentUIMessage[];
  messageDurationMap: Record<string, number>;
  messageStartedAtMap: Record<string, string>;
  lastUserMessageSentAt: string | null;
}

interface ChatsResponse {
  chats: Array<{ id: string }>;
  defaultModelId: string | null;
}

export function ChatRoute() {
  const { sessionId, chatId } = useParams<{
    sessionId: string;
    chatId: string;
  }>();
  const { loading, isAuthenticated, session: authSession } = useSession();

  const [sessionRecord, setSessionRecord] = useState<Session | null>(null);
  const [chatData, setChatData] = useState<ChatResponse | null>(null);
  const [sessionChats, setSessionChats] = useState<ChatsResponse | null>(null);
  const [errorState, setErrorState] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !sessionId || !chatId) return;

    let cancelled = false;

    async function fetchData() {
      try {
        const [sessionRes, chatRes, chatsRes] = await Promise.all([
          fetch(`/api/sessions/${sessionId}`),
          fetch(`/api/sessions/${sessionId}/chats/${chatId}`),
          fetch(`/api/sessions/${sessionId}/chats`),
        ]);

        if (cancelled) return;

        if (sessionRes.status === 404 || chatRes.status === 404) {
          setErrorState("not-found");
          return;
        }

        if (sessionRes.status === 403 || chatRes.status === 403) {
          setErrorState("redirect-home");
          return;
        }

        if (!sessionRes.ok || !chatRes.ok) {
          setErrorState("error");
          return;
        }

        const [sessionData, chatDataRes, chatsDataRes] = await Promise.all([
          sessionRes.json(),
          chatRes.json(),
          chatsRes.json(),
        ]);

        if (cancelled) return;

        if (sessionData.session.userId !== authSession?.user?.id) {
          setErrorState("redirect-home");
          return;
        }

        setSessionRecord(sessionData.session);
        setChatData(chatDataRes);
        setSessionChats(chatsDataRes);
      } catch {
        if (!cancelled) {
          setErrorState("error");
        }
      }
    }

    void fetchData();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, sessionId, chatId, authSession?.user?.id]);

  if (loading) {
    return (
      <RequireAuth>
        <div className="flex h-dvh items-center justify-center">
          <div className="text-muted-foreground">Loading…</div>
        </div>
      </RequireAuth>
    );
  }

  if (!isAuthenticated) {
    return <RequireAuth>{null}</RequireAuth>;
  }

  if (!sessionId || !chatId) {
    return <Navigate to="/sessions" replace />;
  }

  if (errorState === "redirect-home") {
    return <Navigate to="/sessions" replace />;
  }

  if (errorState === "not-found") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-muted-foreground">Not found</div>
      </div>
    );
  }

  if (!sessionRecord || !chatData) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-muted-foreground">Loading chat…</div>
      </div>
    );
  }

  const initialIsOnlyChatInSession = getInitialIsOnlyChatInSession(
    sessionChats?.chats ?? [],
    chatId,
  );

  return (
    <DiffsProvider>
      <SessionChatProvider
        session={sessionRecord}
        chat={chatData.chat}
        initialMessages={chatData.messages}
        initialModelOptions={[]}
      >
        <SessionChatContent
          initialIsOnlyChatInSession={initialIsOnlyChatInSession}
          messageDurationMap={chatData.messageDurationMap}
          messageStartedAtMap={chatData.messageStartedAtMap}
          lastUserMessageSentAt={chatData.lastUserMessageSentAt}
          codeEditorDisabledReason={null}
        />
      </SessionChatProvider>
    </DiffsProvider>
  );
}
