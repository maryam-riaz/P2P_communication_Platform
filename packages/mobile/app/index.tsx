import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../src/redux/store';
import AuthStack from '../src/navigation/AuthStack';
import AppStack from '../src/navigation/AppStack';

export default function RootScreen() {
  const { isLoggedIn } = useSelector((state: RootState) => state.auth);
  return isLoggedIn ? <AppStack /> : <AuthStack />;
}
