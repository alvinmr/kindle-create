# Kindle Create

Desktop app berbasis Tauri untuk mengubah PDF menjadi EPUB yang lebih mudah dibaca di Kindle.

## Arsitektur

- Frontend: Vite + TypeScript tanpa framework.
- Desktop shell: Tauri v2.
- Engine konversi: Calibre `ebook-convert` yang dipanggil dari command Rust.

Pendekatan ini dipilih karena konversi PDF ke EPUB yang bagus cukup sulit jika hanya mengandalkan parsing PDF sendiri. Calibre sudah menangani banyak edge case layout, image, dan metadata lebih baik untuk use case awal.

## Setup lokal

1. Install Node.js 20+.
2. Install Rust toolchain dari https://rustup.rs.
3. Install Calibre, lalu pastikan command `ebook-convert` tersedia di terminal.
4. Install dependency frontend:

```bash
npm install
```

5. Jalankan mode development:

```bash
npm run tauri:dev
```

## Alur aplikasi

1. Pilih file PDF.
2. Preview cover EPUB dari halaman PDF pertama akan dimuat otomatis.
3. Jika perlu, pilih halaman lain untuk cover lalu muat preview ulang.
4. Tentukan lokasi output EPUB.
5. Isi metadata judul atau penulis bila perlu.
6. Jalankan konversi sambil memantau status dan log proses live di panel aktivitas.

## Catatan kualitas hasil

- PDF yang berasal dari scan gambar mungkin tetap menghasilkan EPUB yang kurang rapi.
- Untuk PDF scan, langkah OCR sebelum konversi akan memberi hasil jauh lebih baik.
- Jika target utamanya Kindle, pertimbangkan juga output KEPUB/AZW3 di iterasi berikutnya.
