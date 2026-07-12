import { useSelector } from 'react-redux';
import { RootState } from '../src/redux/store';
import { useEffect } from 'react';
import { secureStore as SecureStore } from '../src/utils/secureStore';
import { useDispatch } from 'react-redux';
import { restoreLogin } from '../src/redux/slices/authSlice';
import AuthStack from '../src/navigation/AuthStack';
import AppStack from '../src/navigation/AppStack';

import { useContext } from 'react';
import { ServiceContext } from '../src/context/ServiceContext';
import { LocalUser } from '../src/db/models';

export default function RootScreen() {
  const dispatch = useDispatch();
  const services = useContext(ServiceContext);
  const { isLoggedIn } = useSelector((state: RootState) => state.auth);

  useEffect(() => {
    const restore = async () => {
      try {
        const db = services?.database;
        if (db) {
          const localUsers = await (db.get('local_user') as any).query().fetch();
          const localUser = localUsers[0];
          
          const user = await SecureStore.getItemAsync('user');
          const role = await SecureStore.getItemAsync('role');

          if (localUser && user && role) {
            const deviceId = (localUser._raw as any).device_id;
            const privateKey = await SecureStore.getItemAsync(`private_key_${deviceId}`);
            if (privateKey) {
              dispatch(restoreLogin({ name: user, role: role as 'user' | 'responder' | 'admin' }));
              return;
            }
          }
        }

        // If validation fails, clear out any stale login details so they go to login screen
        await SecureStore.deleteItemAsync('user');
        await SecureStore.deleteItemAsync('role');
      } catch (e) {
        console.error('Restore failed', e);
      }
    };
    restore();
  }, [services]);

  return isLoggedIn ? <AppStack /> : <AuthStack />;
}