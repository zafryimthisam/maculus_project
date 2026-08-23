#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface MaculusTFLiteTensorInfo : NSObject

@property(nonatomic, readonly, copy) NSString *dataTypeName;
@property(nonatomic, readonly, copy) NSArray<NSNumber *> *shape;
@property(nonatomic, readonly) float scale;
@property(nonatomic, readonly) int32_t zeroPoint;

@end

@interface MaculusTFLiteRunner : NSObject

@property(nonatomic, readonly) MaculusTFLiteTensorInfo *inputInfo;
@property(nonatomic, readonly) MaculusTFLiteTensorInfo *outputInfo;

- (nullable instancetype)initWithModelPath:(NSString *)modelPath
                                     error:(NSError **)error
    NS_SWIFT_NAME(init(modelPath:));

- (nullable NSData *)invokeWithInputData:(NSData *)inputData
                                   error:(NSError **)error
    NS_SWIFT_NAME(invoke(inputData:));

@end

NS_ASSUME_NONNULL_END
