#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyStatus {
    available: bool,
    version: Option<String>,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertPdfRequest {
    input_path: String,
    output_path: String,
    title: Option<String>,
    author: Option<String>,
    language: Option<String>,
    publisher: Option<String>,
    series: Option<String>,
    tags: Option<String>,
    description: Option<String>,
    cover_page: Option<u32>,
    output_preset: Option<OutputPreset>,
    kindle_profile: Option<KindleProfile>,
    use_ocr: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum OutputPreset {
    Small,
    Balanced,
    Quality,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum KindleProfile {
    General,
    Paperwhite,
    Scribe,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionResult {
    success: bool,
    output_path: String,
    log: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobHistoryEntry {
    id: String,
    input_path: String,
    output_path: String,
    status: JobStatus,
    input_size_bytes: Option<u64>,
    output_size_bytes: Option<u64>,
    duration_ms: u128,
    timestamp_ms: u128,
    title: Option<String>,
    author: Option<String>,
    language: Option<String>,
    publisher: Option<String>,
    series: Option<String>,
    tags: Option<String>,
    output_preset: OutputPreset,
    kindle_profile: KindleProfile,
    cover_page: u32,
    used_ocr: bool,
    validation_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
enum JobStatus {
    Success,
    Failed,
    Cancelled,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfPreviewRequest {
    input_path: String,
    page_number: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfMetadata {
    page_count: u32,
    suggested_cover_page: u32,
    is_scan_likely: bool,
    sample_text_characters: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfPreviewResponse {
    page_count: u32,
    page_number: u32,
    data_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgressEvent {
    stage: String,
    message: String,
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    stage: String,
}

#[derive(Default)]
struct ActiveConversion {
    pid: Option<u32>,
    cancel_requested: bool,
}

#[derive(Default)]
struct ConversionCoordinator {
    active: Mutex<ActiveConversion>,
}

fn calibre_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Gagal menentukan folder konfigurasi aplikasi: {error}"))?
        .join("calibre");

    fs::create_dir_all(&directory)
        .map_err(|error| format!("Gagal menyiapkan folder konfigurasi Calibre: {error}"))?;

    Ok(directory)
}

fn app_temp_dir() -> Result<PathBuf, String> {
    let directory = env::temp_dir().join("kindle-create");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Gagal menyiapkan folder temporary aplikasi: {error}"))?;
    Ok(directory)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Gagal menentukan folder data aplikasi: {error}"))?;

    fs::create_dir_all(&directory)
        .map_err(|error| format!("Gagal menyiapkan folder data aplikasi: {error}"))?;
    Ok(directory)
}

fn history_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("job-history.json"))
}

fn pdf_tool_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("pdf_page_tool.swift"),
            resource_dir.join("scripts/pdf_page_tool.swift"),
            resource_dir.join("_up_/scripts/pdf_page_tool.swift"),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    let dev_script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/pdf_page_tool.swift");
    if dev_script.is_file() {
        Ok(dev_script)
    } else {
        Err(format!(
            "Script helper PDF tidak ditemukan di {}",
            dev_script.display()
        ))
    }
}

fn unique_temp_file(prefix: &str, extension: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Gagal membuat nama file temporary: {error}"))?
        .as_millis();

    Ok(app_temp_dir()?.join(format!("{prefix}-{timestamp}.{extension}")))
}

fn ebook_convert_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path_var) = env::var_os("PATH") {
        for directory in env::split_paths(&path_var) {
            candidates.push(directory.join("ebook-convert"));
        }
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/ebook-convert"));
    candidates.push(PathBuf::from("/usr/local/bin/ebook-convert"));
    candidates.push(PathBuf::from(
        "/Applications/calibre.app/Contents/MacOS/ebook-convert",
    ));

    candidates
}

fn resolve_ebook_convert_binary() -> Result<PathBuf, String> {
    ebook_convert_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "Calibre `ebook-convert` tidak ditemukan. Install Calibre atau pastikan binary tersedia di PATH."
                .to_string()
        })
}

fn validate_pdf_path(input_path: &str) -> Result<(), String> {
    let input = Path::new(input_path);
    if !input.exists() {
        return Err("File PDF input tidak ditemukan.".to_string());
    }

    let input_extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if input_extension != "pdf" {
        return Err("Input harus berupa file PDF.".to_string());
    }

    Ok(())
}

fn run_pdf_tool(app: &AppHandle, arguments: &[String]) -> Result<String, String> {
    let script_path = pdf_tool_script_path(app)?;
    let swift_cache_dir = app_temp_dir()?.join("swift-module-cache");
    fs::create_dir_all(&swift_cache_dir)
        .map_err(|error| format!("Gagal menyiapkan Swift module cache: {error}"))?;

    let output = Command::new("/usr/bin/swift")
        .arg(script_path)
        .args(arguments)
        .env("CLANG_MODULE_CACHE_PATH", swift_cache_dir)
        .output()
        .map_err(|error| format!("Gagal menjalankan helper PDF native: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "Helper PDF native gagal tanpa log tambahan.".to_string()
        } else {
            stderr
        })
    }
}

fn inspect_pdf_file(app: &AppHandle, input_path: &str) -> Result<PdfMetadata, String> {
    validate_pdf_path(input_path)?;
    let output = run_pdf_tool(app, &["info".to_string(), input_path.to_string()])?;
    serde_json::from_str::<PdfMetadata>(&output)
        .map_err(|error| format!("Gagal membaca metadata PDF: {error}"))
}

fn render_pdf_page_to_png(
    app: &AppHandle,
    input_path: &str,
    page_number: u32,
    output_path: &Path,
    max_dimension: u32,
) -> Result<(), String> {
    validate_pdf_path(input_path)?;
    run_pdf_tool(app, &[
        "render".to_string(),
        input_path.to_string(),
        page_number.to_string(),
        output_path.to_string_lossy().to_string(),
        max_dimension.to_string(),
    ])?;
    Ok(())
}

fn ebook_convert_version(app: &AppHandle) -> Result<String, String> {
    let config_dir = calibre_config_dir(app)?;
    let ebook_convert = resolve_ebook_convert_binary()?;
    let output = Command::new(ebook_convert)
        .arg("--version")
        .env("CALIBRE_CONFIG_DIRECTORY", config_dir)
        .output()
        .map_err(|error| format!("Gagal menjalankan Calibre `ebook-convert`: {error}"))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn validate_request(request: &ConvertPdfRequest) -> Result<(), String> {
    validate_pdf_path(&request.input_path)?;
    let output = Path::new(&request.output_path);

    let output_extension = output
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if output_extension != "epub" {
        return Err("Output harus berakhiran .epub.".to_string());
    }

    if let Some(parent) = output.parent() {
        if !parent.exists() {
            return Err("Folder output belum ada.".to_string());
        }
    }

    Ok(())
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, detail: Option<String>) {
    let _ = app.emit(
        "conversion-progress",
        ConversionProgressEvent {
            stage: stage.to_string(),
            message: message.to_string(),
            detail,
        },
    );
}

fn now_millis() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Gagal membaca waktu sistem: {error}"))?
        .as_millis())
}

fn load_job_history(app: &AppHandle) -> Result<Vec<JobHistoryEntry>, String> {
    let path = history_file_path(app)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("Gagal membaca riwayat job: {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("Gagal mem-parsing riwayat job: {error}"))
}

fn save_job_history(app: &AppHandle, entry: JobHistoryEntry) -> Result<(), String> {
    let mut entries = load_job_history(app).unwrap_or_default();
    entries.insert(0, entry);
    entries.truncate(100);

    let payload = serde_json::to_string_pretty(&entries)
        .map_err(|error| format!("Gagal menyerialisasi riwayat job: {error}"))?;

    fs::write(history_file_path(app)?, payload)
        .map_err(|error| format!("Gagal menulis riwayat job: {error}"))
}

fn register_conversion(
    coordinator: &Arc<ConversionCoordinator>,
    pid: u32,
) -> Result<(), String> {
    let mut active = coordinator
        .active
        .lock()
        .map_err(|_| "Gagal mengunci state konversi aktif.".to_string())?;

    if active.pid.is_some() {
        return Err("Masih ada proses konversi lain yang sedang berjalan.".to_string());
    }

    active.pid = Some(pid);
    active.cancel_requested = false;
    Ok(())
}

fn clear_conversion(coordinator: &Arc<ConversionCoordinator>) {
    if let Ok(mut active) = coordinator.active.lock() {
        active.pid = None;
        active.cancel_requested = false;
    }
}

fn was_cancel_requested(coordinator: &Arc<ConversionCoordinator>) -> bool {
    coordinator
        .active
        .lock()
        .map(|active| active.cancel_requested)
        .unwrap_or(false)
}

fn resolve_output_preset(preset: Option<OutputPreset>) -> OutputPreset {
    preset.unwrap_or(OutputPreset::Balanced)
}

fn resolve_kindle_profile(profile: Option<KindleProfile>) -> KindleProfile {
    profile.unwrap_or(KindleProfile::General)
}

fn preset_cover_dimension(preset: OutputPreset) -> u32 {
    match preset {
        OutputPreset::Small => 1100,
        OutputPreset::Balanced => 1400,
        OutputPreset::Quality => 1800,
    }
}

fn preset_label(preset: OutputPreset) -> &'static str {
    match preset {
        OutputPreset::Small => "Ukuran Kecil",
        OutputPreset::Balanced => "Seimbang",
        OutputPreset::Quality => "Kualitas Tinggi",
    }
}

fn kindle_profile_label(profile: KindleProfile) -> &'static str {
    match profile {
        KindleProfile::General => "General Kindle",
        KindleProfile::Paperwhite => "Paperwhite",
        KindleProfile::Scribe => "Scribe",
    }
}

fn kindle_output_profile(profile: KindleProfile) -> &'static str {
    match profile {
        KindleProfile::General => "kindle",
        KindleProfile::Paperwhite => "kindle_pw3",
        KindleProfile::Scribe => "kindle_scribe",
    }
}

fn kindle_profile_image_size(profile: KindleProfile, preset: OutputPreset) -> &'static str {
    match (profile, preset) {
        (KindleProfile::General, OutputPreset::Small) => "1100x1600",
        (KindleProfile::General, OutputPreset::Balanced) => "1400x2000",
        (KindleProfile::General, OutputPreset::Quality) => "1800x2600",
        (KindleProfile::Paperwhite, OutputPreset::Small) => "1072x1448",
        (KindleProfile::Paperwhite, OutputPreset::Balanced) => "1236x1648",
        (KindleProfile::Paperwhite, OutputPreset::Quality) => "1448x1920",
        (KindleProfile::Scribe, OutputPreset::Small) => "1248x1664",
        (KindleProfile::Scribe, OutputPreset::Balanced) => "1600x2136",
        (KindleProfile::Scribe, OutputPreset::Quality) => "1860x2480",
    }
}

fn kindle_profile_cover_dimension(profile: KindleProfile, preset: OutputPreset) -> u32 {
    match profile {
        KindleProfile::General => preset_cover_dimension(preset),
        KindleProfile::Paperwhite => match preset {
            OutputPreset::Small => 1200,
            OutputPreset::Balanced => 1500,
            OutputPreset::Quality => 1800,
        },
        KindleProfile::Scribe => match preset {
            OutputPreset::Small => 1400,
            OutputPreset::Balanced => 1800,
            OutputPreset::Quality => 2200,
        },
    }
}

fn kindle_minimum_line_height(profile: KindleProfile) -> &'static str {
    match profile {
        KindleProfile::General => "125",
        KindleProfile::Paperwhite => "130",
        KindleProfile::Scribe => "135",
    }
}

fn kindle_margin_points(profile: KindleProfile) -> &'static str {
    match profile {
        KindleProfile::General => "6",
        KindleProfile::Paperwhite => "8",
        KindleProfile::Scribe => "10",
    }
}

fn file_size(path: &str) -> Option<u64> {
    fs::metadata(path).ok().map(|meta| meta.len())
}

fn sanitize_metadata_field(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn build_history_entry(
    request: &ConvertPdfRequest,
    status: JobStatus,
    duration_ms: u128,
    timestamp_ms: u128,
    output_preset: OutputPreset,
    kindle_profile: KindleProfile,
    cover_page: u32,
    used_ocr: bool,
    validation_message: Option<String>,
) -> JobHistoryEntry {
    JobHistoryEntry {
        id: format!("job-{timestamp_ms}"),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        status,
        input_size_bytes: file_size(&request.input_path),
        output_size_bytes: file_size(&request.output_path),
        duration_ms,
        timestamp_ms,
        title: sanitize_metadata_field(request.title.as_deref()),
        author: sanitize_metadata_field(request.author.as_deref()),
        language: sanitize_metadata_field(request.language.as_deref()),
        publisher: sanitize_metadata_field(request.publisher.as_deref()),
        series: sanitize_metadata_field(request.series.as_deref()),
        tags: sanitize_metadata_field(request.tags.as_deref()),
        output_preset,
        kindle_profile,
        cover_page,
        used_ocr,
        validation_message,
    }
}

fn validate_epub_output(path: &str) -> Result<String, String> {
    let output = Command::new("unzip")
        .args(["-tq", path])
        .output()
        .map_err(|error| format!("Gagal menjalankan validasi EPUB: {error}"))?;

    if output.status.success() {
        Ok("Struktur EPUB lolos pengecekan arsip.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "Validasi EPUB gagal tanpa detail tambahan.".to_string()
        })
    }
}

fn generate_ocr_html(app: &AppHandle, input_path: &str, output_path: &Path) -> Result<(), String> {
    validate_pdf_path(input_path)?;
    run_pdf_tool(app, &[
        "ocr-html".to_string(),
        input_path.to_string(),
        output_path.to_string_lossy().to_string(),
    ])?;
    Ok(())
}

#[tauri::command]
fn check_dependencies(app: AppHandle) -> Result<DependencyStatus, String> {
    match ebook_convert_version(&app) {
        Ok(version) => Ok(DependencyStatus {
            available: true,
            version: Some(version),
            message: "Calibre siap dipakai untuk konversi PDF ke EPUB.".to_string(),
        }),
        Err(message) => Ok(DependencyStatus {
            available: false,
            version: None,
            message: format!(
                "{} Install Calibre lalu pastikan `ebook-convert` bisa dipanggil dari terminal.",
                message
            ),
        }),
    }
}

#[tauri::command]
async fn download_calibre(app: AppHandle) -> Result<String, String> {
    let url = "https://calibre-ebook.com/dist/osx";

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Gagal membuat HTTP client: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Gagal mengunduh Calibre: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Server mengembalikan status {}", response.status()));
    }

    let total_bytes = response.content_length();
    let dmg_path = app_temp_dir()?.join("calibre.dmg");

    let mut file = tokio::fs::File::create(&dmg_path)
        .await
        .map_err(|e| format!("Gagal membuat file temporary: {e}"))?;

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Gagal mengunduh: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Gagal menulis file: {e}"))?;
        downloaded += chunk.len() as u64;

        let _ = app.emit("calibre-download-progress", DownloadProgressEvent {
            downloaded_bytes: downloaded,
            total_bytes,
            stage: "downloading".to_string(),
        });
    }

    file.flush()
        .await
        .map_err(|e| format!("Gagal menyimpan file: {e}"))?;

    // Open the DMG so user can drag-install
    std::process::Command::new("open")
        .arg(&dmg_path)
        .spawn()
        .map_err(|e| format!("Gagal membuka DMG: {e}"))?;

    let _ = app.emit("calibre-download-progress", DownloadProgressEvent {
        downloaded_bytes: downloaded,
        total_bytes,
        stage: "done".to_string(),
    });

    Ok(dmg_path.to_string_lossy().to_string())
}

fn inspect_pdf_impl(app: AppHandle, request: String) -> Result<PdfMetadata, String> {
    inspect_pdf_file(&app, &request)
}

fn preview_pdf_page_impl(app: AppHandle, request: PdfPreviewRequest) -> Result<PdfPreviewResponse, String> {
    let metadata = inspect_pdf_file(&app, &request.input_path)?;

    if request.page_number == 0 || request.page_number > metadata.page_count {
        return Err(format!(
            "Halaman cover harus berada di antara 1 dan {}.",
            metadata.page_count
        ));
    }

    let preview_path = unique_temp_file("cover-preview", "png")?;
    render_pdf_page_to_png(&app, &request.input_path, request.page_number, &preview_path, 1400)?;

    let preview_bytes = fs::read(&preview_path)
        .map_err(|error| format!("Gagal membaca file preview cover: {error}"))?;
    let _ = fs::remove_file(&preview_path);

    let encoded = base64::engine::general_purpose::STANDARD.encode(preview_bytes);

    Ok(PdfPreviewResponse {
        page_count: metadata.page_count,
        page_number: request.page_number,
        data_url: format!("data:image/png;base64,{encoded}"),
    })
}

fn convert_pdf_to_epub_impl(
    app: AppHandle,
    coordinator: Arc<ConversionCoordinator>,
    request: ConvertPdfRequest,
) -> Result<ConversionResult, String> {
    let started_at = now_millis()?;
    let timer = Instant::now();
    validate_request(&request)?;
    let config_dir = calibre_config_dir(&app)?;
    let ebook_convert = resolve_ebook_convert_binary()?;
    ebook_convert_version(&app).map(|_| ())?;
    let metadata = inspect_pdf_file(&app, &request.input_path)?;
    let cover_page = request.cover_page.unwrap_or(1);
    let output_preset = resolve_output_preset(request.output_preset);
    let kindle_profile = resolve_kindle_profile(request.kindle_profile);
    let use_ocr = request.use_ocr.unwrap_or(false);

    if cover_page == 0 || cover_page > metadata.page_count {
        return Err(format!(
            "Halaman cover harus berada di antara 1 dan {}.",
            metadata.page_count
        ));
    }

    emit_progress(
        &app,
        "preparing",
        "Menyiapkan cover EPUB dan proses konversi...",
        Some(format!(
            "Halaman cover: {} | Preset output: {} | Target: {}{}",
            cover_page,
            preset_label(output_preset),
            kindle_profile_label(kindle_profile),
            if use_ocr {
                " | OCR aktif"
            } else {
                ""
            }
        )),
    );

    let cover_path = unique_temp_file("ebook-cover", "jpg")?;
    render_pdf_page_to_png(
        &app,
        &request.input_path,
        cover_page,
        &cover_path,
        kindle_profile_cover_dimension(kindle_profile, output_preset),
    )?;
    emit_progress(
        &app,
        "cover-ready",
        "Cover EPUB berhasil dirender dari PDF.",
        Some(format!("Cover diambil dari halaman {}.", cover_page)),
    );

    let ocr_html_path = if use_ocr {
        emit_progress(
            &app,
            "ocr",
            "Menjalankan OCR native untuk menyiapkan sumber EPUB yang lebih mudah dibaca...",
            Some("PDF scan atau halaman bergambar akan diubah menjadi HTML teks terlebih dahulu.".to_string()),
        );

        let html_path = unique_temp_file("ocr-source", "html")?;
        generate_ocr_html(&app, &request.input_path, &html_path)?;
        Some(html_path)
    } else {
        None
    };

    let conversion_input_path = ocr_html_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| request.input_path.clone());

    let mut command = Command::new(ebook_convert);
    command
        .arg(&conversion_input_path)
        .arg(&request.output_path)
        .env("CALIBRE_CONFIG_DIRECTORY", config_dir)
        .arg("--cover")
        .arg(&cover_path)
        .arg("--output-profile")
        .arg(kindle_output_profile(kindle_profile))
        .arg("--epub-max-image-size")
        .arg(kindle_profile_image_size(kindle_profile, output_preset))
        .args(["--chapter-mark", "none"])
        .args(["--page-breaks-before", "/"])
        .args(["--minimum-line-height", kindle_minimum_line_height(kindle_profile)])
        .args(["--margin-left", kindle_margin_points(kindle_profile)])
        .args(["--margin-right", kindle_margin_points(kindle_profile)])
        .args(["--disable-remove-fake-margins"]);

    if use_ocr {
        command
            .arg("--enable-heuristics")
            .arg("--disable-font-rescaling")
            .args(["--change-justification", "left"]);
    }

    if let Some(title) = request.title.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--title").arg(title);
    }

    if let Some(author) = request.author.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--authors").arg(author);
    }

    if let Some(language) = request.language.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--language").arg(language);
    }

    if let Some(publisher) = request.publisher.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--publisher").arg(publisher);
    }

    if let Some(series) = request.series.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--series").arg(series);
    }

    if let Some(tags) = request.tags.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--tags").arg(tags);
    }

    if let Some(description) = request.description.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--comments").arg(description);
    }

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Gagal menjalankan ebook-convert: {error}"))?;

    if let Err(error) = register_conversion(&coordinator, child.id()) {
        let _ = child.kill();
        let _ = fs::remove_file(&cover_path);
        if let Some(path) = &ocr_html_path {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }

    emit_progress(
        &app,
        "converting",
        "ebook-convert sedang memproses PDF menjadi EPUB...",
        None,
    );

    let log_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        let log_lines = Arc::clone(&log_lines);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }

                if let Ok(mut lines) = log_lines.lock() {
                    lines.push(trimmed.clone());
                }

                emit_progress(
                    &app_handle,
                    "converting",
                    "ebook-convert sedang memproses PDF menjadi EPUB...",
                    Some(trimmed),
                );
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_handle = app.clone();
        let log_lines = Arc::clone(&log_lines);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }

                if let Ok(mut lines) = log_lines.lock() {
                    lines.push(trimmed.clone());
                }

                emit_progress(
                    &app_handle,
                    "converting",
                    "ebook-convert sedang memproses PDF menjadi EPUB...",
                    Some(trimmed),
                );
            }
        });
    }

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            clear_conversion(&coordinator);
            let _ = fs::remove_file(&cover_path);
            if let Some(path) = &ocr_html_path {
                let _ = fs::remove_file(path);
            }
            return Err(format!("Gagal menunggu proses konversi selesai: {error}"));
        }
    };

    let cancelled = was_cancel_requested(&coordinator);
    clear_conversion(&coordinator);

    let combined_log = log_lines
        .lock()
        .map(|lines| lines.join("\n"))
        .unwrap_or_default();
    let duration_ms = timer.elapsed().as_millis();

    let _ = fs::remove_file(&cover_path);
    if let Some(path) = &ocr_html_path {
        let _ = fs::remove_file(path);
    }

    if cancelled {
        let _ = fs::remove_file(&request.output_path);
        let _ = save_job_history(
            &app,
            build_history_entry(
                &request,
                JobStatus::Cancelled,
                duration_ms,
                started_at,
                output_preset,
                kindle_profile,
                cover_page,
                use_ocr,
                None,
            ),
        );
        emit_progress(
            &app,
            "cancelled",
            "Konversi dibatalkan oleh user.",
            Some("Proses converter berhasil dihentikan.".to_string()),
        );
        return Err("Konversi dibatalkan oleh user.".to_string());
    }

    if !status.success() {
        let _ = save_job_history(
            &app,
            build_history_entry(
                &request,
                JobStatus::Failed,
                duration_ms,
                started_at,
                output_preset,
                kindle_profile,
                cover_page,
                use_ocr,
                None,
            ),
        );
        emit_progress(
            &app,
            "error",
            "Konversi gagal.",
            if combined_log.is_empty() {
                None
            } else {
                Some(combined_log.clone())
            },
        );

        return Err(if combined_log.is_empty() {
            "Konversi gagal tanpa log tambahan.".to_string()
        } else {
            combined_log
        });
    }

    emit_progress(
        &app,
        "success",
        "Konversi selesai.",
        Some(request.output_path.clone()),
    );

    let validation_message = match validate_epub_output(&request.output_path) {
        Ok(message) => {
            emit_progress(&app, "validating", "Memeriksa struktur EPUB akhir...", Some(message.clone()));
            Some(message)
        }
        Err(message) => {
            emit_progress(&app, "warning", "EPUB selesai dibuat, tetapi validasi arsip memberi peringatan.", Some(message.clone()));
            Some(message)
        }
    };

    let _ = save_job_history(
        &app,
        build_history_entry(
            &request,
            JobStatus::Success,
            duration_ms,
            started_at,
            output_preset,
            kindle_profile,
            cover_page,
            use_ocr,
            validation_message.clone(),
        ),
    );

    Ok(ConversionResult {
        success: true,
        output_path: request.output_path,
        log: if combined_log.is_empty() {
            "Konversi selesai tanpa output log.".to_string()
        } else {
            combined_log
        },
    })
}

#[tauri::command]
async fn inspect_pdf(app: AppHandle, request: String) -> Result<PdfMetadata, String> {
    async_runtime::spawn_blocking(move || inspect_pdf_impl(app, request))
        .await
        .map_err(|error| format!("Task inspect PDF gagal dijalankan: {error}"))?
}

#[tauri::command]
async fn preview_pdf_page(app: AppHandle, request: PdfPreviewRequest) -> Result<PdfPreviewResponse, String> {
    async_runtime::spawn_blocking(move || preview_pdf_page_impl(app, request))
        .await
        .map_err(|error| format!("Task preview cover gagal dijalankan: {error}"))?
}

#[tauri::command]
async fn convert_pdf_to_epub(app: AppHandle, request: ConvertPdfRequest) -> Result<ConversionResult, String> {
    let coordinator = app.state::<Arc<ConversionCoordinator>>().inner().clone();
    async_runtime::spawn_blocking(move || convert_pdf_to_epub_impl(app, coordinator, request))
        .await
        .map_err(|error| format!("Task konversi gagal dijalankan: {error}"))?
}

#[tauri::command]
fn list_job_history(app: AppHandle) -> Result<Vec<JobHistoryEntry>, String> {
    load_job_history(&app)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Path tidak ditemukan.".to_string());
    }

    let status = Command::new("open")
        .arg(&path)
        .status()
        .map_err(|error| format!("Gagal membuka file: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Sistem gagal membuka file.".to_string())
    }
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Path tidak ditemukan.".to_string());
    }

    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| format!("Gagal membuka Finder: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Finder gagal membuka file.".to_string())
    }
}

#[tauri::command]
fn cancel_conversion(
    app: AppHandle,
    coordinator: State<'_, Arc<ConversionCoordinator>>,
) -> Result<(), String> {
    let pid = {
        let mut active = coordinator
            .active
            .lock()
            .map_err(|_| "Gagal mengunci state konversi aktif.".to_string())?;

        let pid = active
            .pid
            .ok_or_else(|| "Tidak ada proses konversi yang sedang berjalan.".to_string())?;

        active.cancel_requested = true;
        pid
    };

    let status = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .map_err(|error| format!("Gagal mengirim sinyal cancel ke converter: {error}"))?;

    if !status.success() {
        if let Ok(mut active) = coordinator.active.lock() {
            active.cancel_requested = false;
        }
        return Err("Converter menolak perintah cancel.".to_string());
    }

    emit_progress(
        &app,
        "cancelling",
        "Permintaan pembatalan sudah dikirim ke converter.",
        Some(format!("PID converter: {}", pid)),
    );

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(ConversionCoordinator::default()))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_dependencies,
            download_calibre,
            inspect_pdf,
            preview_pdf_page,
            convert_pdf_to_epub,
            cancel_conversion,
            list_job_history,
            open_path,
            reveal_in_finder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
