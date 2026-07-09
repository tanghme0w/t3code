// [agent-hub] Generator for the "Agent Hub Code" app icon.
//
//   swift assets/prod/agent-hub-icon.gen.swift out.iconset
//
// The 1024×1024 master it renders (out.iconset/icon_512x512@2x.png) is
// committed as assets/prod/agent-hub-macos-1024.png, which is the REAL mac
// build input: scripts/lib/brand-assets.ts `productionMacIconPng` points at
// it, and scripts/build-desktop-artifact.ts converts it to icon.icns (bundle
// icon) AND stages it as the asar's resources/icon.png (loaded at runtime by
// DesktopAppIdentity.setDockIcon). Editing apps/desktop/resources/icon.* does
// NOT change the packaged icon — regenerate this master instead.
//
// Design: minimalist multi-provider "hub" — dark-ink macOS squircle, white
// hub-and-spokes, one accent-blue node (the provider currently routed to).

import AppKit
import CoreGraphics

let sizes: [(name: String, px: Int)] = [
  ("icon_16x16", 16), ("icon_16x16@2x", 32),
  ("icon_32x32", 32), ("icon_32x32@2x", 64),
  ("icon_128x128", 128), ("icon_128x128@2x", 256),
  ("icon_256x256", 256), ("icon_256x256@2x", 512),
  ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AgentHubCode.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let ink = NSColor(calibratedRed: 0.106, green: 0.106, blue: 0.118, alpha: 1.0)       // #1B1B1E
let inkTop = NSColor(calibratedRed: 0.165, green: 0.165, blue: 0.184, alpha: 1.0)    // subtle top light
let white = NSColor(calibratedRed: 0.96, green: 0.96, blue: 0.955, alpha: 1.0)
let accent = NSColor(calibratedRed: 0.298, green: 0.616, blue: 0.965, alpha: 1.0)    // #4C9DF6

func draw(px: Int) -> NSBitmapImageRep {
  let s = CGFloat(px) / 1024.0
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

  // macOS icon grid: content squircle inset ~100px on the 1024 canvas.
  let inset = 100.0 * s
  let rect = NSRect(x: inset, y: inset, width: CGFloat(px) - 2 * inset, height: CGFloat(px) - 2 * inset)
  let radius = 185.0 * s
  let squircle = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
  // Soft vertical gradient so the slab doesn't read as flat black.
  NSGradient(starting: inkTop, ending: ink)!.draw(in: squircle, angle: -90)

  // Hub geometry (1024 space): center node + three spokes at 90/210/330 deg.
  let c = CGFloat(px) / 2.0
  let spokeR = 238.0 * s
  let nodeR = 46.0 * s
  let hubR = 66.0 * s
  let lineW = 24.0 * s
  let angles: [CGFloat] = [90, 210, 330]
  var points: [NSPoint] = []
  for a in angles {
    let rad = a * .pi / 180
    points.append(NSPoint(x: c + spokeR * cos(rad), y: c + spokeR * sin(rad)))
  }

  white.setStroke()
  for p in points {
    let line = NSBezierPath()
    line.move(to: NSPoint(x: c, y: c))
    line.line(to: p)
    line.lineWidth = lineW
    line.lineCapStyle = .round
    line.stroke()
  }

  // Outer nodes: top one is the accent (the provider currently routed to).
  for (i, p) in points.enumerated() {
    (i == 0 ? accent : white).setFill()
    NSBezierPath(ovalIn: NSRect(x: p.x - nodeR, y: p.y - nodeR, width: nodeR * 2, height: nodeR * 2)).fill()
  }

  white.setFill()
  NSBezierPath(ovalIn: NSRect(x: c - hubR, y: c - hubR, width: hubR * 2, height: hubR * 2)).fill()
  // Ink pinhole in the hub — makes it a ring, lighter feel.
  ink.setFill()
  let holeR = 26.0 * s
  NSBezierPath(ovalIn: NSRect(x: c - holeR, y: c - holeR, width: holeR * 2, height: holeR * 2)).fill()

  NSGraphicsContext.restoreGraphicsState()
  return rep
}

for (name, px) in sizes {
  let rep = draw(px: px)
  let data = rep.representation(using: .png, properties: [:])!
  try! data.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}
print("iconset written to \(outDir)")
