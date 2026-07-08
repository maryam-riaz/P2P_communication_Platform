import { useSelector } from 'react-redux';
import { RootState } from '../src/redux/store';
import { useEffect } from 'react';
import { secureStore as SecureStore } from '../src/utils/secureStore';
import { useDispatch } from 'react-redux';
import { restoreLogin } from '../src/redux/slices/authSlice';
import AuthStack from '../src/navigation/AuthStack';
import AppStack from '../src/navigation/AppStack';

export default function RootScreen() {
  const dispatch = useDispatch();
  const { isLoggedIn } = useSelector((state: RootState) => state.auth);

  useEffect(() => {
    const restore = async () => {
      try {
        const user = await SecureStore.getItemAsync('user');
        const role = await SecureStore.getItemAsync('role');
        if (user && role) {
          dispatch(restoreLogin({ name: user, role: role as 'user' | 'responder' | 'admin' }));
        }
      } catch (e) {
        console.error('Restore failed', e);
      }
    };
    restore();
  }, []);

  return isLoggedIn ? <AppStack /> : <AuthStack />;
}