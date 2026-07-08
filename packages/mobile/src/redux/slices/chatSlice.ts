import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  status: 'sent' | 'delivered' | 'read' | 'pending';
  mediaUrl?: string;
}

export interface Chat {
  id: string;
  participantId: string;
  participantName: string;
  participantType: 'user' | 'responder';
  messages: Message[];
  isGroup: boolean;
  groupMembers?: Array<{ id: string; name: string }>;
  unreadCount: number;
  lastMessage?: Message;
}

interface ChatState {
  chats: Chat[];
  activeChat: string | null;
  typingUsers: string[];
  unreadCount: number;
}

const initialState: ChatState = {
  chats: [],
  activeChat: null,
  typingUsers: [],
  unreadCount: 0,
};

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    createChat: (state, action: PayloadAction<Chat>) => {
      const exists = state.chats.find(c => c.id === action.payload.id);
      if (!exists) {
        state.chats.push(action.payload);
      }
    },
    addMessage: (state, action: PayloadAction<{ chatId: string; message: Message }>) => {
      const chat = state.chats.find(c => c.id === action.payload.chatId);
      if (chat) {
        chat.messages.push(action.payload.message);
        chat.lastMessage = action.payload.message;
      }
    },
    setActiveChat: (state, action: PayloadAction<string | null>) => {
      state.activeChat = action.payload;
    },
    addTypingUser: (state, action: PayloadAction<string>) => {
      if (!state.typingUsers.includes(action.payload)) {
        state.typingUsers.push(action.payload);
      }
    },
    removeTypingUser: (state, action: PayloadAction<string>) => {
      state.typingUsers = state.typingUsers.filter(u => u !== action.payload);
    },
    markChatAsRead: (state, action: PayloadAction<string>) => {
      const chat = state.chats.find(c => c.id === action.payload);
      if (chat) {
        chat.unreadCount = 0;
      }
    },
    incrementUnreadCount: (state, action: PayloadAction<string>) => {
      const chat = state.chats.find(c => c.id === action.payload);
      if (chat) {
        chat.unreadCount += 1;
      }
    },
    updateMessageStatus: (state, action: PayloadAction<{ chatId: string; messageId: string; status: Message['status'] }>) => {
      const chat = state.chats.find(c => c.id === action.payload.chatId);
      if (chat) {
        const message = chat.messages.find(m => m.id === action.payload.messageId);
        if (message) {
          message.status = action.payload.status;
        }
      }
    },
  },
});

export const {
  createChat,
  addMessage,
  setActiveChat,
  addTypingUser,
  removeTypingUser,
  markChatAsRead,
  incrementUnreadCount,
  updateMessageStatus,
} = chatSlice.actions;
export default chatSlice.reducer;
