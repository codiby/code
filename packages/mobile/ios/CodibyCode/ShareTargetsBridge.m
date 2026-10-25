#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ShareTargets, NSObject)
RCT_EXTERN_METHOD(configure:(NSString *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(cacheSessions:(NSString *)snapshot
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(read:(NSString *)requestId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(finish:(NSString *)requestId
                  sent:(BOOL)sent
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
