import { configureStore } from '@reduxjs/toolkit';
import authReducer from './slices/authSlice';
import mapReducer from './slices/mapSlice';
import chatReducer from './slices/chatSlice';
import emergencyReducer from './slices/emergencySlice';
import advisorReducer from './slices/advisorSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    map: mapReducer,
    chat: chatReducer,
    emergency: emergencyReducer,
    advisor: advisorReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
