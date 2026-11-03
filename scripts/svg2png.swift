// ホーム画面（リッチメニュー）の絵を SVG から 2500×843 の PNG にする。Mac だけ。使い方: swift scripts/svg2png.swift docs/assets/richmenu.svg docs/assets/richmenu.png
import AppKit
let args = CommandLine.arguments
guard args.count == 3, let img = NSImage(contentsOfFile: args[1]) else { print("load failed"); exit(1) }
let w = 2500, h = 843
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: w, height: h), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("ok")
