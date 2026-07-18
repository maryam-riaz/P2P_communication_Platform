(global as any).__DEV__ = true;
jest.mock('react-native-ble-manager', () => ({}));
jest.mock('react-native', () => ({ NativeModules: {} }));
import { packFullPayload, packTrimmedPayload } from '../ble/ble-advertiser';
import { parseAdvertisementPacket } from '../ble/ble-scanner';
import { UserRole } from '../ble/ble-types';

describe('BLE Role Mapping', () => {
  const roles: UserRole[] = ['user', 'responder', 'admin'];
  const testDeviceId = '12345678-1234-1234-1234-123456789abc';
  const testPkHash = 'abcdef12';

  roles.forEach(role => {
    it(`should correctly round-trip the '${role}' role in a full payload`, () => {
      const fullPayload = packFullPayload(testDeviceId, role, testPkHash);
      const parsed = parseAdvertisementPacket(fullPayload);
      expect(parsed).not.toBeNull();
      expect(parsed?.role).toBe(role);
    });

    it(`should correctly round-trip the '${role}' role in a trimmed payload`, () => {
      const trimmedPayload = packTrimmedPayload(testDeviceId, role, testPkHash);
      const parsed = parseAdvertisementPacket(trimmedPayload);
      expect(parsed).not.toBeNull();
      expect(parsed?.role).toBe(role);
    });
  });
});
