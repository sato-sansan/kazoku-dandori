// SVG を PNG にする。Mac だけ。大きさを省くと 2500×843（リッチメニュー）
//   使い方: swift scripts/svg2png.swift docs/assets/richmenu.svg docs/assets/richmenu.png
//           swift scripts/svg2png.swift docs/assets/icon.svg docs/assets/icon.png 640 640
import AppKit
let args = CommandLine.arguments
guard args.count == 3 || args.count == 5, let img = NSImage(contentsOfFile: args[1]) else { print("usage: svg2png in.svg out.png [w h]"); exit(1) }
let w = args.count == 5 ? Int(args[3])! : 2500, h = args.count == 5 ? Int(args[4])! : 843
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: w, height: h), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("ok")
