// Draws the app icon (rounded square, gradient, speech-bubble-with-check glyph) at every size macOS wants.
//   swift tools/make-icon.swift Assistant/Assets.xcassets/AppIcon.appiconset
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px), inset = s * 0.08, r = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = NSBezierPath(roundedRect: r, xRadius: r.width * 0.2237, yRadius: r.width * 0.2237)
    NSGradient(colors: [NSColor(srgbRed: 0.18, green: 0.42, blue: 0.90, alpha: 1), NSColor(srgbRed: 0.20, green: 0.55, blue: 0.95, alpha: 1)])!.draw(in: path, angle: -60)
    let cfg = NSImage.SymbolConfiguration(pointSize: s * 0.5, weight: .semibold).applying(.init(paletteColors: [.white]))
    if let g = NSImage(systemSymbolName: "checkmark.bubble.fill", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
        let size = g.size; g.draw(in: NSRect(x: (s - size.width) / 2, y: (s - size.height) / 2, width: size.width, height: size.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}
var images: [[String: String]] = []
for base in [16, 32, 128, 256, 512] { for scale in [1, 2] {
    let name = "icon_\(base)x\(base)\(scale == 2 ? "@2x" : "").png"
    try! render(base * scale).write(to: out.appendingPathComponent(name))
    images.append(["idiom": "mac", "size": "\(base)x\(base)", "scale": "\(scale)x", "filename": name])
} }
let json = try! JSONSerialization.data(withJSONObject: ["images": images, "info": ["version": 1, "author": "xcode"]], options: [.prettyPrinted, .sortedKeys])
try! json.write(to: out.appendingPathComponent("Contents.json"))
