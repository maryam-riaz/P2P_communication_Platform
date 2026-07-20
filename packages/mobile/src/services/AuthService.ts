import { Database } from '@nozbe/watermelondb';
import { secureStore as SecureStore } from '../utils/secureStore';
import uuid from 'react-native-uuid';
import { generateKeyPair } from 'shared';
import { MobileRepository } from '../db/repository';
import { LocalUser } from '../db/models';
import { Observable } from 'rxjs';
import { logger } from '../utils/logger';

export class AuthService {
  private repository: MobileRepository;

  constructor(private db: Database) {
    this.repository = new MobileRepository(db);
  }

  /**
   * Returns the current logged-in user profile, if it exists.
   */
  async getCurrentUser(): Promise<LocalUser | null> {
    return await this.repository.getLocalUser();
  }

  /**
   * Returns a live-updating Observable of the current user profile.
   */
  observeCurrentUser(): Observable<LocalUser[]> {
    return this.db.get<LocalUser>('local_user').query().observe();
  }

  /**
   * Registers a new user session, generates ECDH keys, writes the identity to WatermelonDB,
   * and saves the private key inside Expo SecureStore.
   */
  async login(role: 'user' | 'responder' | 'admin', displayName: string): Promise<LocalUser> {
    try {
      const deviceId = uuid.v4() as string;
      const keypair = generateKeyPair();

      // Write to WatermelonDB local_user table
      const localUser = await this.repository.setLocalUser({
        deviceId,
        role,
        publicKey: keypair.publicKey,
        displayName,
      });

      // Save private key securely in keychain (not in DB)
      await SecureStore.setItemAsync(`private_key_${deviceId}`, keypair.privateKey);
      await SecureStore.setItemAsync('user', displayName);
      await SecureStore.setItemAsync('role', role);

      return localUser;
    } catch (error: any) {
      throw new Error(`AuthService Login failed: ${error.message}`);
    }
  }

  /**
   * Log out. Clears local user profile from database and Keychain.
   */
  async logout(): Promise<void> {
    const user = await this.getCurrentUser();
    if (user) {
      const deviceId = (user._raw as any).device_id as string;
      await SecureStore.deleteItemAsync(`private_key_${deviceId}`);
    }
    
    await SecureStore.deleteItemAsync('user');
    await SecureStore.deleteItemAsync('role');

    // Wipe local_user table
    await this.db.write(async () => {
      const allUsers = await this.db.get<LocalUser>('local_user').query().fetch();
      for (const u of allUsers) {
        await u.destroyPermanently();
      }
    });
  }
}
