/**
 * Type declarations for react-native-ble-advertiser.
 * The library ships no bundled TypeScript types, so we declare the minimal
 * API surface used by BleAdvertiser here.
 */
declare module 'react-native-ble-advertiser' {
  interface AdvertiseSettings {
    /** Advertise mode: 0 = LOW_POWER, 1 = BALANCED, 2 = LOW_LATENCY */
    advertiseMode?: number;
    /** TX power level: -1 = ULTRA_LOW, 0 = LOW, 1 = MEDIUM, 2 = HIGH */
    txPowerLevel?: number;
    /** Whether the device should be connectable */
    connectable?: boolean;
    /** Advertising timeout in ms (0 = no timeout) */
    timeout?: number;
  }

  interface AdvertiseData {
    /** List of service UUIDs to include in the advertisement */
    serviceUUIDs?: string[];
    /** Manufacturer ID (company identifier) */
    manufacturerId?: number;
    /** Base64-encoded manufacturer-specific data bytes */
    manufacturerData?: number[];
    /** Local device name to broadcast */
    includeDeviceName?: boolean;
    /** Include TX power level in the advertisement */
    includeTxPowerLevel?: boolean;
  }

  const BleAdvertiser: {
    /**
     * Sets the company identifier used in manufacturer-specific data.
     * Must be called before startBroadcast.
     */
    setCompanyId(companyId: number): void;

    /**
     * Starts BLE advertising.
     * @param uid      The primary service UUID to advertise.
     * @param payload  Array of byte values (manufacturer data body).
     * @param settings Optional advertise settings.
     * @returns        Promise that resolves when advertising has started.
     */
    startBroadcast(
      uid: string,
      payload: number[],
      settings?: AdvertiseSettings
    ): Promise<void>;

    /**
     * Stops BLE advertising.
     * @returns Promise that resolves when advertising has stopped.
     */
    stopBroadcast(): Promise<void>;
  };

  export default BleAdvertiser;
}
