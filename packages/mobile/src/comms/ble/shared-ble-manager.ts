import { BleManager } from 'react-native-ble-plx';

/**
 * A single app-wide BleManager instance.
 *
 * react-native-ble-plx's BleManager wraps a native BLE stack object. Creating
 * more than one (e.g. one inside BleScanner for peer discovery, and a second
 * one ad-hoc inside a screen just to poll `state()`) means two separate
 * native listeners/handles fighting over the same radio, which is wasteful
 * and has been a contributing factor to main-thread jank during BLE bursts.
 *
 * Anything that needs a BleManager (discovery scanning, a simple "is
 * Bluetooth on?" check, etc.) should import `sharedBleManager` from here
 * instead of calling `new BleManager()` directly.
 *
 * Do NOT call `.destroy()` on this from a screen/component's cleanup — it's
 * shared app-wide. Only destroy it once, on full app teardown, if ever.
 */
export const sharedBleManager = new BleManager();