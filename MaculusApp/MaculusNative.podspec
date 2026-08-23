Pod::Spec.new do |spec|
  spec.name         = 'MaculusNative'
  spec.version      = '1.0.0'
  spec.summary      = 'Offline iOS vision and voice modules for Maculus.'
  spec.homepage     = 'https://github.com/zafryimthisam/maculus_project'
  spec.license      = { :type => 'MIT' }
  spec.author       = 'Maculus contributors'
  spec.source       = { :git => 'https://github.com/zafryimthisam/maculus_project.git', :tag => spec.version.to_s }
  spec.platform     = :ios, '13.4'
  spec.swift_version = '5.0'

  spec.source_files = 'ios/MaculusApp/MaculusNative/**/*.{swift,m,h}'
  spec.public_header_files = 'ios/MaculusApp/MaculusNative/**/*.h'
  spec.resources = [
    'android/app/src/main/assets/yolo11s.tflite',
    'android/app/src/main/assets/coco-labels.txt',
    'android/app/src/main/assets/depth_anything_v2_small_uint8_256.onnx',
    'android/app/src/main/assets/person_reid_osnet_x0_25.onnx',
    'android/app/src/main/assets/person_reid_osnet_x0_25.onnx.sha256',
    'android/app/src/main/assets/wakeword/*.onnx'
  ]

  spec.frameworks = 'AVFoundation', 'Accelerate', 'ImageIO', 'Speech', 'UIKit'
  spec.dependency 'React-Core'
  # The bundled YOLO model has signed INT8 I/O. TensorFlowLiteObjC exposes
  # that tensor type, whereas the Swift wrapper omits it.
  spec.dependency 'TensorFlowLiteObjC', '2.17.0'
  spec.dependency 'onnxruntime-objc', '1.18.0'
end
