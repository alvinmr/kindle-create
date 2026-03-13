import AppKit
import Foundation
import PDFKit

struct PdfInfo: Codable {
    let pageCount: Int
}

enum PdfToolError: Error, LocalizedError {
    case invalidArguments(String)
    case unableToOpenPdf(String)
    case invalidPage(Int)
    case unableToCreateImage
    case unableToEncodePng
    case unableToEncodeJpeg

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message):
            return message
        case .unableToOpenPdf(let path):
            return "Tidak bisa membuka PDF: \(path)"
        case .invalidPage(let page):
            return "Halaman PDF tidak valid: \(page)"
        case .unableToCreateImage:
            return "Gagal membuat bitmap preview PDF."
        case .unableToEncodePng:
            return "Gagal mengubah preview PDF menjadi PNG."
        case .unableToEncodeJpeg:
            return "Gagal mengubah cover PDF menjadi JPEG."
        }
    }
}

func loadDocument(path: String) throws -> PDFDocument {
    let url = URL(fileURLWithPath: path)
    guard let document = PDFDocument(url: url) else {
        throw PdfToolError.unableToOpenPdf(path)
    }
    return document
}

func printJson<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    let data = try encoder.encode(value)
    guard let json = String(data: data, encoding: .utf8) else {
        throw PdfToolError.invalidArguments("Gagal menulis output JSON.")
    }
    FileHandle.standardOutput.write(Data(json.utf8))
}

func encodeImage(_ bitmap: NSBitmapImageRep, outputPath: String) throws -> Data {
    let lowercasedPath = outputPath.lowercased()

    if lowercasedPath.hasSuffix(".jpg") || lowercasedPath.hasSuffix(".jpeg") {
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else {
            throw PdfToolError.unableToEncodeJpeg
        }
        return data
    }

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw PdfToolError.unableToEncodePng
    }
    return data
}

func renderPage(document: PDFDocument, pageNumber: Int, outputPath: String, maxDimension: CGFloat) throws {
    guard let page = document.page(at: pageNumber - 1) else {
        throw PdfToolError.invalidPage(pageNumber)
    }

    let mediaBox = page.bounds(for: .mediaBox)
    let width = max(mediaBox.width, 1)
    let height = max(mediaBox.height, 1)
    let scale = maxDimension / max(width, height)
    let targetWidth = max(Int((width * scale).rounded()), 1)
    let targetHeight = max(Int((height * scale).rounded()), 1)

    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: targetWidth,
        pixelsHigh: targetHeight,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw PdfToolError.unableToCreateImage
    }

    guard let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw PdfToolError.unableToCreateImage
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphicsContext
    graphicsContext.imageInterpolation = .high

    NSColor.white.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: targetWidth, height: targetHeight)).fill()

    let cgContext = graphicsContext.cgContext
    cgContext.scaleBy(x: CGFloat(targetWidth) / width, y: CGFloat(targetHeight) / height)
    page.draw(with: .mediaBox, to: cgContext)
    cgContext.flush()

    NSGraphicsContext.restoreGraphicsState()

    let imageData = try encodeImage(bitmap, outputPath: outputPath)
    try imageData.write(to: URL(fileURLWithPath: outputPath))
}

func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3 else {
        throw PdfToolError.invalidArguments(
            "Usage: pdf_page_tool.swift <info|render> <pdfPath> [pageNumber outputPath maxDimension]"
        )
    }

    let command = arguments[1]
    let pdfPath = arguments[2]
    let document = try loadDocument(path: pdfPath)

    switch command {
    case "info":
        try printJson(PdfInfo(pageCount: document.pageCount))
    case "render":
        guard arguments.count >= 6 else {
            throw PdfToolError.invalidArguments(
                "Usage: pdf_page_tool.swift render <pdfPath> <pageNumber> <outputPath> <maxDimension>"
            )
        }

        guard let pageNumber = Int(arguments[3]), pageNumber > 0 else {
            throw PdfToolError.invalidArguments("Nomor halaman harus berupa angka positif.")
        }

        let outputPath = arguments[4]
        let maxDimension = CGFloat(Double(arguments[5]) ?? 1400)
        try renderPage(
            document: document,
            pageNumber: pageNumber,
            outputPath: outputPath,
            maxDimension: max(maxDimension, 400)
        )
    default:
        throw PdfToolError.invalidArguments("Perintah tidak dikenali: \(command)")
    }
}

do {
    try main()
} catch {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
