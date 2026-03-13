import AppKit
import Foundation
import PDFKit
import Vision

struct PdfInfo: Codable {
    let pageCount: Int
    let suggestedCoverPage: Int
    let isScanLikely: Bool
    let sampleTextCharacters: Int
}

enum PdfToolError: Error, LocalizedError {
    case invalidArguments(String)
    case unableToOpenPdf(String)
    case invalidPage(Int)
    case unableToCreateImage
    case unableToCreateCgImage
    case unableToEncodePng
    case unableToEncodeJpeg
    case ocrFailed(String)

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
        case .unableToCreateCgImage:
            return "Gagal membuat CGImage untuk OCR."
        case .unableToEncodePng:
            return "Gagal mengubah preview PDF menjadi PNG."
        case .unableToEncodeJpeg:
            return "Gagal mengubah cover PDF menjadi JPEG."
        case .ocrFailed(let message):
            return message
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

func preferredPageRect(for page: PDFPage) -> NSRect {
    for box in [PDFDisplayBox.trimBox, .cropBox, .mediaBox] {
        let rect = page.bounds(for: box)
        if rect.width > 0, rect.height > 0 {
            return rect
        }
    }

    return page.bounds(for: .mediaBox)
}

func coverFocusedRect(for page: PDFPage) -> NSRect {
    let baseRect = preferredPageRect(for: page)
    let aspectRatio = baseRect.width / max(baseRect.height, 1)

    if aspectRatio <= 1.12 {
        return baseRect
    }

    let portraitWidth = min(baseRect.width, max(baseRect.height * 0.72, baseRect.width * 0.24))
    return NSRect(
        x: baseRect.maxX - portraitWidth,
        y: baseRect.minY,
        width: portraitWidth,
        height: baseRect.height
    )
}

func makeBitmap(document: PDFDocument, pageNumber: Int, maxDimension: CGFloat) throws -> NSBitmapImageRep {
    guard let page = document.page(at: pageNumber - 1) else {
        throw PdfToolError.invalidPage(pageNumber)
    }

    let renderRect = coverFocusedRect(for: page)
    let width = max(renderRect.width, 1)
    let height = max(renderRect.height, 1)
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
    cgContext.translateBy(x: -renderRect.minX, y: -renderRect.minY)
    page.draw(with: .mediaBox, to: cgContext)
    cgContext.flush()

    NSGraphicsContext.restoreGraphicsState()

    return bitmap
}

func renderPage(document: PDFDocument, pageNumber: Int, outputPath: String, maxDimension: CGFloat) throws {
    let bitmap = try makeBitmap(document: document, pageNumber: pageNumber, maxDimension: maxDimension)

    let imageData = try encodeImage(bitmap, outputPath: outputPath)
    try imageData.write(to: URL(fileURLWithPath: outputPath))
}

func normalizeText(_ value: String?) -> String {
    guard let value else {
        return ""
    }

    return value
        .replacingOccurrences(of: "\u{00A0}", with: " ")
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func suggestCoverPage(document: PDFDocument) -> (page: Int, scanLikely: Bool, sampleTextCharacters: Int) {
    let sampleCount = max(1, min(document.pageCount, 8))
    var bestPage = 1
    var bestScore = Int.min
    var totalTextCharacters = 0

    for pageNumber in 1...sampleCount {
        let text = normalizeText(document.page(at: pageNumber - 1)?.string)
        let lowercasedText = text.lowercased()
        let textCount = text.count
        totalTextCharacters += textCount

        var score = 0
        if pageNumber == 1 {
            score += 60
        }
        if pageNumber <= 3 {
            score += 24 - (pageNumber * 4)
        }
        if textCount == 0 {
            score += 90
        } else if textCount < 80 {
            score += 60
        } else if textCount < 180 {
            score += 30
        } else if textCount > 900 {
            score -= 25
        }

        if lowercasedText.contains("table of contents") || lowercasedText.contains("contents") {
            score -= 50
        }
        if lowercasedText.contains("copyright") || lowercasedText.contains("all rights reserved") {
            score -= 40
        }
        if lowercasedText.contains("chapter") || lowercasedText.contains("bab ") {
            score -= 18
        }

        if score > bestScore {
            bestScore = score
            bestPage = pageNumber
        }
    }

    let scanLikely = totalTextCharacters < (sampleCount * 80)
    return (bestPage, scanLikely, totalTextCharacters)
}

func escapeHtml(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

func recognizeTextFromBitmap(_ bitmap: NSBitmapImageRep) throws -> String {
    guard let cgImage = bitmap.cgImage else {
        throw PdfToolError.unableToCreateCgImage
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["id-ID", "en-US"]

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let sorted = observations.sorted { lhs, rhs in
        let yDelta = abs(lhs.boundingBox.midY - rhs.boundingBox.midY)
        if yDelta > 0.02 {
            return lhs.boundingBox.midY > rhs.boundingBox.midY
        }
        return lhs.boundingBox.minX < rhs.boundingBox.minX
    }

    let lines = sorted.compactMap { observation -> String? in
        observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    .filter { !$0.isEmpty }

    return normalizeText(lines.joined(separator: "\n"))
}

func extractBestPageText(document: PDFDocument, pageNumber: Int) throws -> String {
    guard document.page(at: pageNumber - 1) != nil else {
        throw PdfToolError.invalidPage(pageNumber)
    }

    let directText = normalizeText(document.page(at: pageNumber - 1)?.string)
    if directText.count >= 40 {
        return directText
    }

    do {
        let bitmap = try makeBitmap(document: document, pageNumber: pageNumber, maxDimension: 1800)
        let ocrText = try recognizeTextFromBitmap(bitmap)
        return ocrText.isEmpty ? directText : ocrText
    } catch {
        return directText
    }
}

func writeOcrHtml(document: PDFDocument, outputPath: String) throws {
    var sections: [String] = []
    for pageNumber in 1...max(document.pageCount, 1) {
        let text = try extractBestPageText(document: document, pageNumber: pageNumber)
        let safeText = escapeHtml(text.isEmpty ? "[Halaman \(pageNumber) tidak berhasil dibaca OCR]" : text)
            .replacingOccurrences(of: "\n", with: "<br />")

        sections.append(
            """
            <section class="page">
              <h2>Halaman \(pageNumber)</h2>
              <p>\(safeText)</p>
            </section>
            """
        )
    }

    let html = """
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>OCR Source</title>
        <style>
          body { font-family: Georgia, serif; margin: 0 auto; max-width: 42rem; line-height: 1.65; padding: 2rem 1.2rem 4rem; }
          h1, h2 { font-family: "Iowan Old Style", Georgia, serif; }
          h2 { page-break-before: always; font-size: 1rem; letter-spacing: 0.08em; text-transform: uppercase; color: #7c4a1f; margin-top: 2.4rem; }
          p { white-space: normal; text-align: left; margin: 0.75rem 0 0; }
          .page:first-of-type h2 { page-break-before: auto; }
        </style>
      </head>
      <body>
        <h1>OCR Source</h1>
        \(sections.joined(separator: "\n"))
      </body>
    </html>
    """

    try html.write(to: URL(fileURLWithPath: outputPath), atomically: true, encoding: .utf8)
}

func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3 else {
        throw PdfToolError.invalidArguments(
            "Usage: pdf_page_tool.swift <info|render|ocr-html> <pdfPath> [pageNumber outputPath maxDimension]"
        )
    }

    let command = arguments[1]
    let pdfPath = arguments[2]
    let document = try loadDocument(path: pdfPath)

    switch command {
    case "info":
        let coverAnalysis = suggestCoverPage(document: document)
        try printJson(
            PdfInfo(
                pageCount: document.pageCount,
                suggestedCoverPage: coverAnalysis.page,
                isScanLikely: coverAnalysis.scanLikely,
                sampleTextCharacters: coverAnalysis.sampleTextCharacters
            )
        )
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
    case "ocr-html":
        guard arguments.count >= 4 else {
            throw PdfToolError.invalidArguments(
                "Usage: pdf_page_tool.swift ocr-html <pdfPath> <outputHtmlPath>"
            )
        }

        try writeOcrHtml(document: document, outputPath: arguments[3])
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
