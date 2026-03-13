#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, Manager};

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
    cover_page: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionResult {
    success: bool,
    output_path: String,
    log: String,
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

fn convert_pdf_to_epub_impl(app: AppHandle, request: ConvertPdfRequest) -> Result<ConversionResult, String> {
    validate_request(&request)?;
    let config_dir = calibre_config_dir(&app)?;
    let ebook_convert = resolve_ebook_convert_binary()?;
    ebook_convert_version(&app).map(|_| ())?;
    let metadata = inspect_pdf_file(&app, &request.input_path)?;
    let cover_page = request.cover_page.unwrap_or(1);

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
        Some(format!("Halaman cover yang dipakai: {}", cover_page)),
    );

    let cover_path = unique_temp_file("ebook-cover", "jpg")?;
    render_pdf_page_to_png(&app, &request.input_path, cover_page, &cover_path, 1400)?;
    emit_progress(
        &app,
        "cover-ready",
        "Cover EPUB berhasil dirender dari PDF.",
        Some(format!("Cover diambil dari halaman {}.", cover_page)),
    );

    let mut command = Command::new(ebook_convert);
    command
        .arg(&request.input_path)
        .arg(&request.output_path)
        .env("CALIBRE_CONFIG_DIRECTORY", config_dir)
        .arg("--cover")
        .arg(&cover_path)
        .arg("--epub-max-image-size")
        .arg("1400x2000")
        .args(["--chapter-mark", "none"])
        .args(["--page-breaks-before", "/"])
        .args(["--disable-remove-fake-margins"]);

    if let Some(title) = request.title.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--title").arg(title);
    }

    if let Some(author) = request.author.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--authors").arg(author);
    }

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Gagal menjalankan ebook-convert: {error}"))?;

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

    let status = child
        .wait()
        .map_err(|error| format!("Gagal menunggu proses konversi selesai: {error}"))?;

    let combined_log = log_lines
        .lock()
        .map(|lines| lines.join("\n"))
        .unwrap_or_default();

    let _ = fs::remove_file(&cover_path);

    if !status.success() {
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
    async_runtime::spawn_blocking(move || convert_pdf_to_epub_impl(app, request))
        .await
        .map_err(|error| format!("Task konversi gagal dijalankan: {error}"))?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_dependencies,
            inspect_pdf,
            preview_pdf_page,
            convert_pdf_to_epub
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
