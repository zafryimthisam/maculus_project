#import "ImageProcessor.h"
#import <UIKit/UIKit.h>

@implementation ImageProcessor

RCT_EXPORT_MODULE(ImageProcessor);

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

RCT_EXPORT_METHOD(preprocessYOLO:(NSString *)base64Image
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    @try {
        NSDictionary *result = [self preprocess:base64Image targetSize:640 normalizeTo01:YES];
        resolve(result);
    } @catch (NSException *exception) {
        reject(@"PREPROCESS_ERROR", exception.reason, nil);
    }
}

RCT_EXPORT_METHOD(preprocessScene:(NSString *)base64Image
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    @try {
        NSDictionary *result = [self preprocess:base64Image targetSize:224 normalizeTo01:NO];
        resolve(result);
    } @catch (NSException *exception) {
        reject(@"PREPROCESS_ERROR", exception.reason, nil);
    }
}

- (NSDictionary *)preprocess:(NSString *)base64Image targetSize:(int)targetSize normalizeTo01:(BOOL)normalizeTo01 {
    NSData *imageData = [[NSData alloc] initWithBase64EncodedString:base64Image options:NSDataBase64DecodingIgnoreUnknownCharacters];
    if (!imageData) {
        @throw [NSException exceptionWithName:@"InvalidImageException" reason:@"Failed to decode base64 image data" userInfo:nil];
    }
    UIImage *original = [UIImage imageWithData:imageData];
    if (!original) {
        @throw [NSException exceptionWithName:@"InvalidImageException" reason:@"Failed to create UIImage from data" userInfo:nil];
    }

    UIGraphicsImageRendererFormat *rendererFormat = [UIGraphicsImageRendererFormat defaultFormat];
    rendererFormat.scale = 1.0;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(targetSize, targetSize) format:rendererFormat];
    UIImage *scaled = [renderer imageWithActions:^(UIGraphicsImageRendererContext * _Nonnull rendererContext) {
        [original drawInRect:CGRectMake(0, 0, targetSize, targetSize)];
    }];

    if (!scaled) {
        @throw [NSException exceptionWithName:@"InvalidImageException" reason:@"Failed to scale image" userInfo:nil];
    }

    CGImageRef cgImage = scaled.CGImage;
    if (!cgImage) {
        @throw [NSException exceptionWithName:@"InvalidImageException" reason:@"Failed to get CGImage representation" userInfo:nil];
    }

    NSUInteger width = CGImageGetWidth(cgImage);
    NSUInteger height = CGImageGetHeight(cgImage);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    NSUInteger bytesPerPixel = 4;
    NSUInteger bytesPerRow = bytesPerPixel * width;
    NSUInteger bitsPerComponent = 8;
    unsigned char *rawData = (unsigned char *)calloc(height * width * 4, sizeof(unsigned char));
    CGContextRef context = CGBitmapContextCreate(rawData, width, height, bitsPerComponent, bytesPerRow, colorSpace, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), cgImage);
    CGColorSpaceRelease(colorSpace);
    CGContextRelease(context);

    int floatCount = (int)(width * height * 3);
    NSMutableData *floatData = [NSMutableData dataWithLength:floatCount * sizeof(float)];
    float *floats = (float *)[floatData mutableBytes];

    int idx = 0;
    for (int i = 0; i < height * width; i++) {
        float r = (float)rawData[i * 4];
        float g = (float)rawData[i * 4 + 1];
        float b = (float)rawData[i * 4 + 2];

        if (normalizeTo01) {
            r /= 255.0f;
            g /= 255.0f;
            b /= 255.0f;
        }

        floats[idx++] = r;
        floats[idx++] = g;
        floats[idx++] = b;
    }
    free(rawData);

    NSString *outBase64 = [floatData base64EncodedStringWithOptions:0];

    return @{
        @"base64": outBase64,
        @"width": @(width),
        @"height": @(height)
    };
}

@end
