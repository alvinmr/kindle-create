# Kindle Create Roadmap

Backlog ini disusun untuk menjaga scope tetap realistis. Urutannya mengikuti kombinasi impact user, risiko teknis, dan ketergantungan implementasi.

## v0.2.0

### Preset Output
- [x] Tambahkan pilihan preset `Ukuran Kecil`, `Seimbang`, `Kualitas Tinggi`
- [x] Map tiap preset ke opsi converter yang relevan
- [x] Tampilkan ringkasan efek preset di UI
- [x] Simpan preset terakhir yang dipilih user

Effort: kecil
Impact: tinggi

### Drag And Drop PDF
- [x] Tambahkan area drop file di langkah pilih dokumen
- [x] Validasi hanya file `.pdf`
- [x] Isi otomatis input path, output path, dan metadata awal
- [x] Trigger inspect PDF setelah file berhasil di-drop

Effort: kecil
Impact: tinggi

### Cancel Conversion
- [x] Simpan handle proses `ebook-convert` yang sedang berjalan
- [x] Tambahkan command backend untuk membatalkan proses aktif
- [x] Tambahkan tombol `Cancel` di langkah konversi
- [x] Tampilkan status `Cancelled` di log dan badge aktivitas
- [x] Pastikan file temporary cover dibersihkan saat proses dibatalkan

Effort: menengah
Impact: tinggi

## v0.3.0

### Riwayat Job
- [x] Simpan riwayat convert ke file JSON di app data directory
- [x] Simpan field input, output, status, ukuran sebelum/sesudah, durasi, timestamp
- [x] Tampilkan list riwayat di UI
- [x] Tambahkan aksi `Open output` dan `Reveal in Finder`

Effort: kecil-menengah
Impact: tinggi

### Metadata Lengkap
- [x] Tambahkan field `language`
- [x] Tambahkan field `publisher`
- [x] Tambahkan field `series`
- [x] Tambahkan field `tags`
- [x] Tambahkan field `description`
- [x] Map seluruh field ke flag metadata converter yang sesuai

Effort: kecil-menengah
Impact: sedang

### Preview EPUB
- [x] Tambahkan tombol `Buka EPUB` setelah convert berhasil
- [x] Tambahkan tombol `Reveal in Finder`
- [x] Pastikan output path valid sebelum tombol diaktifkan

Effort: kecil
Impact: sedang

## v0.4.0

### Batch Convert
- [x] Tambahkan pemilihan multi-file PDF
- [x] Buat queue job konversi
- [x] Tampilkan status per item: pending, running, success, error, cancelled
- [x] Tambahkan aksi `retry failed`
- [x] Tambahkan opsi output folder bersama

Effort: menengah-besar
Impact: tinggi

### Smart Cover Detection
- [x] Analisis beberapa halaman awal PDF
- [x] Tentukan heuristik untuk kandidat cover terbaik
- [x] Tampilkan rekomendasi otomatis sebelum user memilih manual
- [x] Tetap izinkan override manual

Effort: menengah
Impact: sedang-tinggi

## v0.5.0

### OCR Untuk PDF Scan
- [x] Evaluasi engine OCR yang paling realistis untuk macOS desktop
- [x] Buat pipeline OCR opsional sebelum proses convert
- [x] Tampilkan indikator apakah PDF terdeteksi scan atau text-based
- [x] Tambahkan opsi `Gunakan OCR`
- [x] Tangani hasil OCR yang gagal atau parsial

Effort: besar
Impact: sangat tinggi untuk scan PDF

### Kindle Optimization Mode
- [x] Tambahkan target device `General Kindle`
- [x] Tambahkan target device `Paperwhite`
- [x] Tambahkan target device `Scribe`
- [x] Sesuaikan image sizing, output profile, spacing, dan cover treatment

Effort: menengah
Impact: sedang

## Prioritas Global

Urutan implementasi paling aman:

1. Preset Output
2. Drag And Drop PDF
3. Cancel Conversion
4. Riwayat Job
5. Metadata Lengkap
6. Preview EPUB
7. Batch Convert
8. Smart Cover Detection
9. Kindle Optimization Mode
10. OCR Untuk PDF Scan

## Catatan Teknis

- `Cancel Conversion` sebaiknya selesai sebelum `Batch Convert`, karena fondasi manajemen prosesnya akan dipakai ulang.
- `Preset Output` harus selesai sebelum `Kindle Optimization Mode`, supaya mapping opsi converter sudah rapi.
- `OCR` sebaiknya ditunda sampai flow dasar, riwayat job, dan batch queue sudah stabil.
- `Smart Cover Detection` tidak boleh menggantikan pemilihan manual, hanya memberi saran default yang lebih baik.
