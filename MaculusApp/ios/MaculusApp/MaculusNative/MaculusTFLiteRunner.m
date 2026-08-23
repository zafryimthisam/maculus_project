#import "MaculusTFLiteRunner.h"

@import TFLTensorFlowLite;

@interface MaculusTFLiteTensorInfo ()

@property(nonatomic, readwrite, copy) NSString *dataTypeName;
@property(nonatomic, readwrite, copy) NSArray<NSNumber *> *shape;
@property(nonatomic, readwrite) float scale;
@property(nonatomic, readwrite) int32_t zeroPoint;

- (nullable instancetype)initWithTensor:(TFLTensor *)tensor
                                   error:(NSError **)error;

@end


@implementation MaculusTFLiteTensorInfo

- (instancetype)initWithTensor:(TFLTensor *)tensor error:(NSError **)error {
  self = [super init];
  if (self == nil) {
    return nil;
  }

  switch (tensor.dataType) {
    case TFLTensorDataTypeFloat32:
      _dataTypeName = @"float32";
      break;
    case TFLTensorDataTypeUInt8:
      _dataTypeName = @"uint8";
      break;
    case TFLTensorDataTypeInt8:
      _dataTypeName = @"int8";
      break;
    default:
      if (error != NULL) {
        *error = [NSError errorWithDomain:@"MaculusTFLite"
                                     code:1
                                 userInfo:@{
                                   NSLocalizedDescriptionKey:
                                       [NSString stringWithFormat:@"Unsupported tensor type: %lu",
                                                                  (unsigned long)tensor.dataType]
                                 }];
      }
      return nil;
  }

  NSArray<NSNumber *> *shape = [tensor shapeWithError:error];
  if (shape == nil) {
    return nil;
  }
  _shape = [shape copy];
  TFLQuantizationParameters *quantization = tensor.quantizationParameters;
  _scale = quantization != nil ? quantization.scale : 1.0f;
  _zeroPoint = quantization != nil ? quantization.zeroPoint : 0;
  return self;
}

@end


@interface MaculusTFLiteRunner ()

@property(nonatomic, strong) TFLInterpreter *interpreter;
@property(nonatomic, strong) TFLTensor *inputTensor;
@property(nonatomic, strong) TFLTensor *outputTensor;
@property(nonatomic, readwrite, strong) MaculusTFLiteTensorInfo *inputInfo;
@property(nonatomic, readwrite, strong) MaculusTFLiteTensorInfo *outputInfo;

@end


@implementation MaculusTFLiteRunner

- (nullable instancetype)initWithModelPath:(NSString *)modelPath error:(NSError **)error {
  self = [super init];
  if (self == nil) {
    return nil;
  }

  TFLInterpreterOptions *options = [[TFLInterpreterOptions alloc] init];
  options.numberOfThreads = 4;
  options.useXNNPACK = YES;
  _interpreter = [[TFLInterpreter alloc] initWithModelPath:modelPath
                                                   options:options
                                                     error:error];
  if (_interpreter == nil || ![_interpreter allocateTensorsWithError:error]) {
    return nil;
  }

  _inputTensor = [_interpreter inputTensorAtIndex:0 error:error];
  _outputTensor = [_interpreter outputTensorAtIndex:0 error:error];
  if (_inputTensor == nil || _outputTensor == nil) {
    return nil;
  }

  _inputInfo = [[MaculusTFLiteTensorInfo alloc] initWithTensor:_inputTensor error:error];
  _outputInfo = [[MaculusTFLiteTensorInfo alloc] initWithTensor:_outputTensor error:error];
  if (_inputInfo == nil || _outputInfo == nil) {
    return nil;
  }
  return self;
}

- (nullable NSData *)invokeWithInputData:(NSData *)inputData error:(NSError **)error {
  if (![_inputTensor copyData:inputData error:error] ||
      ![_interpreter invokeWithError:error]) {
    return nil;
  }
  return [_outputTensor dataWithError:error];
}

@end
