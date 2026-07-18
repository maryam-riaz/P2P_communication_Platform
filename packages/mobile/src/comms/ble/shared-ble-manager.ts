/**
 * Shared BLE Manager initialization
 * Handles initialization of the native BLE module.
 */

import BleManager from 'react-native-ble-manager';

/**
 * Initialize the BLE manager.
 * Call this once at app startup, before starting any BLE operations.
 */
export async function initializeBleManager(): Promise<void> {
  try {
    // Start the BLE module (no UI alerts, silent mode)
    await BleManager.start({ showAlert: false });
    console.log('[BLE] Manager initialized successfully');
  } catch (error) {
    console.error('[BLE] Failed to initialize BleManager:', error);
    throw error;
  }
}

/**
 * Check if BLE is enabled on the device.
 */
export async function isBleEnabled(): Promise<boolean> {
  try {
    const state = await BleManager.checkState();
    // state can be 'on', 'off', 'unknown', 'resetting'
    return state === 'on';
  } catch (error) {
    console.error('[BLE] Error checking BLE state:', error);
    return false;
  }
}

/**
 * Get the current BLE state.
 */
export async function getBleState(): Promise<string> {
  try {
    return await BleManager.checkState();
  } catch (error) {
    console.error('[BLE] Error getting BLE state:', error);
    return 'unknown';
  }
}

export { BleManager };