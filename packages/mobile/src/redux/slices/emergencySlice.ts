import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface EmergencyFormData {
  type: 'injury' | 'fire' | 'lost' | 'medical' | 'other' | '';
  description: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  resourcesNeeded: string[];
  customResource: string;
  mediaUrls: string[];
}

interface EmergencyState {
  formData: EmergencyFormData;
  submissionStatus: 'idle' | 'submitting' | 'success' | 'error';
  submissionError: string | null;
  draftMedia: string[];
}

const initialState: EmergencyState = {
  formData: {
    type: '',
    description: '',
    location: '',
    latitude: null,
    longitude: null,
    resourcesNeeded: [],
    customResource: '',
    mediaUrls: [],
  },
  submissionStatus: 'idle',
  submissionError: null,
  draftMedia: [],
};

const emergencySlice = createSlice({
  name: 'emergency',
  initialState,
  reducers: {
    updateFormData: (state, action: PayloadAction<Partial<EmergencyFormData>>) => {
      state.formData = { ...state.formData, ...action.payload };
    },
    setEmergencyType: (state, action: PayloadAction<EmergencyFormData['type']>) => {
      state.formData.type = action.payload;
    },
    setEmergencyDescription: (state, action: PayloadAction<string>) => {
      state.formData.description = action.payload;
    },
    setEmergencyLocation: (state, action: PayloadAction<{ location: string; latitude: number; longitude: number }>) => {
      state.formData.location = action.payload.location;
      state.formData.latitude = action.payload.latitude;
      state.formData.longitude = action.payload.longitude;
    },
    toggleResource: (state, action: PayloadAction<string>) => {
      const index = state.formData.resourcesNeeded.indexOf(action.payload);
      if (index > -1) {
        state.formData.resourcesNeeded.splice(index, 1);
      } else {
        state.formData.resourcesNeeded.push(action.payload);
      }
    },
    setCustomResource: (state, action: PayloadAction<string>) => {
      state.formData.customResource = action.payload;
    },
    addMedia: (state, action: PayloadAction<string>) => {
      state.formData.mediaUrls.push(action.payload);
      state.draftMedia.push(action.payload);
    },
    removeMedia: (state, action: PayloadAction<string>) => {
      state.formData.mediaUrls = state.formData.mediaUrls.filter(url => url !== action.payload);
      state.draftMedia = state.draftMedia.filter(url => url !== action.payload);
    },
    setSubmissionStatus: (state, action: PayloadAction<'idle' | 'submitting' | 'success' | 'error'>) => {
      state.submissionStatus = action.payload;
    },
    setSubmissionError: (state, action: PayloadAction<string | null>) => {
      state.submissionError = action.payload;
    },
    resetForm: (state) => {
      state.formData = initialState.formData;
      state.submissionStatus = 'idle';
      state.submissionError = null;
      state.draftMedia = [];
    },
  },
});

export const {
  updateFormData,
  setEmergencyType,
  setEmergencyDescription,
  setEmergencyLocation,
  toggleResource,
  setCustomResource,
  addMedia,
  removeMedia,
  setSubmissionStatus,
  setSubmissionError,
  resetForm,
} = emergencySlice.actions;
export default emergencySlice.reducer;
