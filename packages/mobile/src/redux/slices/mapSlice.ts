import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface Location {
  latitude: number;
  longitude: number;
}

interface NearbyPerson {
  id: string;
  name: string;
  type: 'user' | 'responder';
  location: Location;
  distance: number;
  status: 'active' | 'inactive';
  signalStrength: number;
}

interface MapState {
  userLocation: Location | null;
  nearbyUsers: NearbyPerson[];
  nearbyRescuers: NearbyPerson[];
  connectionStatus: 'connected' | 'disconnected';
  zoomLevel: number;
}

const initialState: MapState = {
  userLocation: null,
  nearbyUsers: [],
  nearbyRescuers: [],
  connectionStatus: 'disconnected',
  zoomLevel: 12,
};

const mapSlice = createSlice({
  name: 'map',
  initialState,
  reducers: {
    setUserLocation: (state, action: PayloadAction<Location>) => {
      state.userLocation = action.payload;
    },
    setNearbyUsers: (state, action: PayloadAction<NearbyPerson[]>) => {
      state.nearbyUsers = action.payload;
    },
    setNearbyRescuers: (state, action: PayloadAction<NearbyPerson[]>) => {
      state.nearbyRescuers = action.payload;
    },
    updateConnectionStatus: (state, action: PayloadAction<'connected' | 'disconnected'>) => {
      state.connectionStatus = action.payload;
    },
    setZoomLevel: (state, action: PayloadAction<number>) => {
      state.zoomLevel = action.payload;
    },
    addNearbyUser: (state, action: PayloadAction<NearbyPerson>) => {
      const exists = state.nearbyUsers.find(u => u.id === action.payload.id);
      if (!exists) {
        state.nearbyUsers.push(action.payload);
      }
    },
    addNearbyRescuer: (state, action: PayloadAction<NearbyPerson>) => {
      const exists = state.nearbyRescuers.find(r => r.id === action.payload.id);
      if (!exists) {
        state.nearbyRescuers.push(action.payload);
      }
    },
    removeNearbyUser: (state, action: PayloadAction<string>) => {
      state.nearbyUsers = state.nearbyUsers.filter(u => u.id !== action.payload);
    },
    removeNearbyRescuer: (state, action: PayloadAction<string>) => {
      state.nearbyRescuers = state.nearbyRescuers.filter(r => r.id !== action.payload);
    },
  },
});

export const {
  setUserLocation,
  setNearbyUsers,
  setNearbyRescuers,
  updateConnectionStatus,
  setZoomLevel,
  addNearbyUser,
  addNearbyRescuer,
  removeNearbyUser,
  removeNearbyRescuer,
} = mapSlice.actions;
export default mapSlice.reducer;
