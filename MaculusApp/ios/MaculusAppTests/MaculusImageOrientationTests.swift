import MaculusNative
import UIKit
import XCTest

final class MaculusImageOrientationTests: XCTestCase {
  func testRGBTensorRowsMatchVisibleTopToBottomOrder() throws {
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    let image = UIGraphicsImageRenderer(
      size: CGSize(width: 4, height: 4),
      format: format
    ).image { context in
      UIColor.red.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 2))
      UIColor.blue.setFill()
      context.fill(CGRect(x: 0, y: 2, width: 4, height: 2))
    }

    let rgb = try MaculusImage.rgbBytes(image)
    XCTAssertEqual(rgb.count, 4 * 4 * 3)

    let firstRowPixel = Array(rgb[0..<3])
    let lastRowOffset = (4 * 3) * 3
    let lastRowPixel = Array(rgb[lastRowOffset..<(lastRowOffset + 3)])

    XCTAssertGreaterThan(firstRowPixel[0], 200, "Visible top row must remain red")
    XCTAssertLessThan(firstRowPixel[2], 30, "Visible top row must not be flipped blue")
    XCTAssertLessThan(lastRowPixel[0], 30, "Visible bottom row must not be flipped red")
    XCTAssertGreaterThan(lastRowPixel[2], 200, "Visible bottom row must remain blue")
  }
}
