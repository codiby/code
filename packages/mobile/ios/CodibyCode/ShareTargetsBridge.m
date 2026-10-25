#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ShareTargets, NSObject)
RCT_EXTERN_METHOD(configure:(NSString *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
