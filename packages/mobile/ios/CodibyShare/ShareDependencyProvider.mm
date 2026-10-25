#import "ShareDependencyProvider.h"
#import <React/RCTComponentViewProtocol.h>

// La extensión registra solo los componentes que utiliza ShareApp.
@implementation ShareDependencyProvider
- (NSArray<NSString *> *)imageURLLoaderClassNames { return @[]; }
- (NSArray<NSString *> *)imageDataDecoderClassNames { return @[]; }
- (NSArray<NSString *> *)URLRequestHandlerClassNames { return @[]; }
- (NSArray<NSString *> *)unstableModulesRequiringMainQueueSetup { return @[]; }
- (NSDictionary *)moduleProviders { return @{}; }
- (NSDictionary<NSString *, Class<RCTComponentViewProtocol>> *)thirdPartyFabricComponents {
  NSDictionary<NSString *, NSString *> *names = @{
    @"RNCSafeAreaProvider": @"RNCSafeAreaProviderComponentView",
    @"RNCSafeAreaView": @"RNCSafeAreaViewComponentView",
    @"RNSVGCircle": @"RNSVGCircle",
    @"RNSVGClipPath": @"RNSVGClipPath",
    @"RNSVGDefs": @"RNSVGDefs",
    @"RNSVGEllipse": @"RNSVGEllipse",
    @"RNSVGFeBlend": @"RNSVGFeBlend",
    @"RNSVGFeColorMatrix": @"RNSVGFeColorMatrix",
    @"RNSVGFeComposite": @"RNSVGFeComposite",
    @"RNSVGFeFlood": @"RNSVGFeFlood",
    @"RNSVGFeGaussianBlur": @"RNSVGFeGaussianBlur",
    @"RNSVGFeMerge": @"RNSVGFeMerge",
    @"RNSVGFeOffset": @"RNSVGFeOffset",
    @"RNSVGFilter": @"RNSVGFilter",
    @"RNSVGForeignObject": @"RNSVGForeignObject",
    @"RNSVGGroup": @"RNSVGGroup",
    @"RNSVGImage": @"RNSVGImage",
    @"RNSVGLine": @"RNSVGLine",
    @"RNSVGLinearGradient": @"RNSVGLinearGradient",
    @"RNSVGMarker": @"RNSVGMarker",
    @"RNSVGMask": @"RNSVGMask",
    @"RNSVGPath": @"RNSVGPath",
    @"RNSVGPattern": @"RNSVGPattern",
    @"RNSVGRadialGradient": @"RNSVGRadialGradient",
    @"RNSVGRect": @"RNSVGRect",
    @"RNSVGSvgView": @"RNSVGSvgView",
    @"RNSVGSymbol": @"RNSVGSymbol",
    @"RNSVGTSpan": @"RNSVGTSpan",
    @"RNSVGText": @"RNSVGText",
    @"RNSVGTextPath": @"RNSVGTextPath",
    @"RNSVGUse": @"RNSVGUse",
  };
  NSMutableDictionary *components = [NSMutableDictionary new];
  for (NSString *name in names) {
    Class component = NSClassFromString(names[name]);
    if (component) components[name] = component;
  }
  return components;
}
@end
