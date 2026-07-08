import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface AdvisorFlow {
  id: string;
  category: 'injury' | 'fire' | 'disaster' | 'medical' | 'lost' | 'other';
  steps: AdvisorStep[];
  currentStep: number;
}

export interface AdvisorStep {
  id: string;
  type: 'question' | 'advice';
  title: string;
  content: string;
  options?: { id: string; label: string; nextStepId?: string }[];
  icon?: string;
}

interface AdvisorState {
  currentScenario: string | null;
  currentFlow: AdvisorFlow | null;
  conversationStep: number;
  history: string[];
  selectedAnswers: { [key: string]: string };
}

const initialState: AdvisorState = {
  currentScenario: null,
  currentFlow: null,
  conversationStep: 0,
  history: [],
  selectedAnswers: {},
};

const advisorSlice = createSlice({
  name: 'advisor',
  initialState,
  reducers: {
    setCurrentScenario: (state, action: PayloadAction<string>) => {
      state.currentScenario = action.payload;
    },
    initializeFlow: (state, action: PayloadAction<AdvisorFlow>) => {
      state.currentFlow = action.payload;
      state.conversationStep = 0;
      state.history = [action.payload.steps[0].id];
    },
    nextStep: (state, action: PayloadAction<{ stepId: string; answerId?: string }>) => {
      if (state.currentFlow) {
        state.history.push(action.payload.stepId);
        if (action.payload.answerId) {
          state.selectedAnswers[state.conversationStep] = action.payload.answerId;
        }
        state.conversationStep += 1;
      }
    },
    previousStep: (state) => {
      if (state.conversationStep > 0) {
        state.history.pop();
        state.conversationStep -= 1;
      }
    },
    resetFlow: (state) => {
      state.currentScenario = null;
      state.currentFlow = null;
      state.conversationStep = 0;
      state.history = [];
      state.selectedAnswers = {};
    },
  },
});

export const { setCurrentScenario, initializeFlow, nextStep, previousStep, resetFlow } = advisorSlice.actions;
export default advisorSlice.reducer;
