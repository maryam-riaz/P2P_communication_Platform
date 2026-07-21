// MultipeerConnectivityModule.m
// React Native bridge module for iOS Multipeer Connectivity.
//
// Phase 1 — Native Mesh Transport Module
//   - Explicit connect (JS decides when to invite)
//   - Reconnection with exponential backoff
//   - Consistent event names with Android Nearby Connections
//
// Integration steps (requires macOS + Xcode):
// 1. Run `npx expo prebuild --platform ios` to generate the ios/ directory
// 2. Copy this file and MultipeerConnectivityModule.swift into ios/Sosify/
// 3. Add both files to the Xcode project (File → Add Files to "Sosify")
// 4. Ensure MultipeerConnectivity.framework is linked in Build Phases
// 5. Add TEAM_ID_APPLE_DEV as the development team in Signing & Capabilities
// 6. Run on two physical iOS devices

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(MultipeerConnectivity, RCTEventEmitter)

RCT_EXTERN_METHOD(startAdvertising:(NSString *)serviceType
                  deviceName:(NSString *)deviceName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopAdvertising:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startDiscovery:(NSString *)serviceType
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopDiscovery:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(connect:(NSString *)peerId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disconnectFromEndpoint:(NSString *)peerId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendPayload:(NSString *)peerId
                  base64Data:(NSString *)base64Data
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendPayloadToAll:(NSString *)base64Data
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getConnectedEndpoints:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getRSSI:(NSString *)peerId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
