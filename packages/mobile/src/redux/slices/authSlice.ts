import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type UserRole = 'user' | 'responder' | 'admin';

interface AuthState {
  isLoggedIn: boolean;
  user: string | null;
  role: UserRole | null;
  loginError: string | null;
}

const initialState: AuthState = {
  isLoggedIn: false,
  user: null,
  role: null,
  loginError: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    login: (state, action: PayloadAction<{ name: string; role: UserRole }>) => {
      state.isLoggedIn = true;
      state.user = action.payload.name;
      state.role = action.payload.role;
      state.loginError = null;
    },
    logout: (state) => {
      state.isLoggedIn = false;
      state.user = null;
      state.role = null;
    },
    setLoginError: (state, action: PayloadAction<string>) => {
      state.loginError = action.payload;
    },
    clearLoginError: (state) => {
      state.loginError = null;
    },
    restoreLogin: (state, action: PayloadAction<{ name: string; role: UserRole }>) => {
      state.isLoggedIn = true;
      state.user = action.payload.name;
      state.role = action.payload.role;
    },
  },
});

export const { login, logout, setLoginError, clearLoginError, restoreLogin } = authSlice.actions;
export default authSlice.reducer;
