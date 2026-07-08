import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import AuthStack from './AuthStack';
import AppStack from './AppStack';

export default function RootNavigator() {
  const { isLoggedIn } = useSelector((state: RootState) => state.auth);

  return isLoggedIn ? <AppStack /> : <AuthStack />;
}
