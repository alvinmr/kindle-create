# Kindle Create

A desktop PDF-to-EPUB converter built for Kindle workflows. Select a PDF, configure metadata and output settings, and generate a Kindle-ready EPUB.

## Tech Stack

- **Frontend:** TypeScript + Vite (no framework)
- **Backend:** Rust + [Tauri 2](https://tauri.app/)
- **Conversion:** Wraps Calibre's `ebook-convert` CLI, with optional Ghostscript and Tesseract OCR

## Features

- PDF to EPUB conversion with live progress and log output
- Metadata editing (title, author, language, publisher, series, tags, description)
- Cover page selection with PDF preview
- Output presets (small, balanced, quality) and Kindle device profiles
- Optional OCR for scanned PDFs
- Batch conversion with drag-and-drop
- Conversion history

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/tools/install)
- [Calibre](https://calibre-ebook.com/) — provides the `ebook-convert` command
- [Ghostscript](https://www.ghostscript.com/) — for PDF preview rendering
- [Tesseract](https://github.com/tesseract-ocr/tesseract) — optional, for OCR on scanned PDFs

## Getting Started

```bash
# Install frontend dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build for production
npm run tauri:build
```

## Notes

- Scanned PDFs may produce lower-quality EPUBs. Enabling OCR before conversion helps significantly.
- Calibre handles most layout, image, and metadata edge cases well for this use case.
