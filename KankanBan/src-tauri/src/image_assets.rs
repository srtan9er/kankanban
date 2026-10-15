//! Raster assets are immutable and live outside the core text mirror.
use serde::{Deserialize, Serialize};
use std::{fs::{self, File, OpenOptions}, io::{Cursor, Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use base64::Engine;
use image::{AnimationDecoder, ImageDecoder, ImageFormat, ImageReader};
use sha2::{Digest, Sha256};

pub(crate) const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 150 * 1024 * 1024;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_ANIMATION_PIXELS: u64 = 200_000_000;
const MAX_FRAMES: usize = 1_000;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

async fn run_image_work<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    use std::sync::{Arc, OnceLock};
    static IMAGE_WORK: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let gate = Arc::clone(IMAGE_WORK.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2))));
    // Await admission before scheduling blocking work; queued images consume no worker threads.
    let permit = gate.acquire_owned().await.map_err(io_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Keep admission while decoding even if the caller drops its response future.
        let _permit = permit;
        work()
    }).await.map_err(io_error)?
}

fn error(key: &str) -> String { crate::i18n::text(&format!("native/images.{key}"), &[]) }
fn io_error(error: impl std::fmt::Display) -> String { crate::i18n::text("native/images.io", &[("arg0", error.to_string())]) }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageInput {
    name: String,
    base64: Option<String>,
    path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAsset {
    pub asset_id: String,
    pub name: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn validate_asset_id(id: &str) -> Result<(), String> {
    let (hash, ext) = id.split_once('.').ok_or_else(|| error("invalidAssetId"))?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !matches!(ext, "png" | "jpg" | "webp" | "gif") { return Err(error("invalidAssetId")); }
    Ok(())
}

fn image_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION); limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(320 * 1024 * 1024); limits
}

fn checked_name(name: &str) -> Result<String, String> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control) { return Err(error("invalidName")); }
    Ok(name.to_owned())
}

fn decode_image(bytes: &[u8], name: &str) -> Result<ImageAsset, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES { return Err(error("tooLarge")); }
    let format = image::guess_format(bytes).map_err(|_| error("unsupportedFormat"))?;
    let (ext, mime) = match format {
        ImageFormat::Png => ("png", "image/png"), ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        ImageFormat::WebP => ("webp", "image/webp"), ImageFormat::Gif => ("gif", "image/gif"),
        _ => return Err(error("unsupportedFormat")),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format); reader.limits(image_limits());
    let (width, height) = reader.into_dimensions().map_err(|_| error("invalidImage"))?;
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(error("dimensions"));
    }
    // Header probes alone accept broken compressed payloads. Decode the actual raster.
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format); reader.limits(image_limits());
    reader.decode().map_err(|_| error("invalidImage"))?;
    // Validate every animated frame while bounding total decoding work.
    match format {
        ImageFormat::Gif => {
            let mut decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(|_| error("invalidImage"))?;
            decoder.set_limits(image_limits()).map_err(|_| error("dimensions"))?;
            validate_frames(decoder.into_frames())?;
        }
        ImageFormat::WebP => {
            let mut decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|_| error("invalidImage"))?;
            decoder.set_limits(image_limits()).map_err(|_| error("dimensions"))?;
            if decoder.has_animation() { validate_frames(decoder.into_frames())?; }
        }
        _ => {},
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    Ok(ImageAsset { asset_id: format!("{hash}.{ext}"), name: checked_name(name)?, mime: mime.into(), width, height })
}

fn validate_frames(frames: image::Frames<'_>) -> Result<(), String> {
    let mut pixels = 0u64;
    for (count, frame) in frames.enumerate() {
        if count >= MAX_FRAMES { return Err(error("dimensions")); }
        let frame = frame.map_err(|_| error("invalidImage"))?;
        pixels += u64::from(frame.buffer().width()) * u64::from(frame.buffer().height());
        if pixels > MAX_ANIMATION_PIXELS { return Err(error("dimensions")); }
    }
    Ok(())
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

fn asset_directory(root: &Path, create: bool) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(io_error)?;
    let mut current = root.clone();
    for part in [".kkb", "assets", "images"] {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if !linked(&metadata) && metadata.is_dir() => {},
            Ok(_) => return Err(error("unsafePath")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&current).map_err(io_error)?;
                let metadata = fs::symlink_metadata(&current).map_err(io_error)?;
                if linked(&metadata) || !metadata.is_dir() { return Err(error("unsafePath")); }
            }
            Err(e) => return Err(io_error(e)),
        }
        if !current.canonicalize().map_err(io_error)?.starts_with(&root) { return Err(error("unsafePath")); }
    }
    Ok(current)
}

fn bounded_read(path: &Path, limit: usize, external: bool) -> Result<Vec<u8>, String> {
    if external && !path.is_absolute() { return Err(error("unsafePath")); }
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if linked(&metadata) || !metadata.is_file() { return Err(error("unsafePath")); }
    if metadata.len() > limit as u64 { return Err(error("tooLarge")); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path).map_err(io_error)?.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len() > limit { return Err(error("tooLarge")); }
    Ok(bytes)
}

/// Assets are immutable; deleting cards never deletes files used by undo or instances.
pub(crate) fn store_image(root: &Path, bytes: &[u8], name: &str) -> Result<ImageAsset, String> {
    let asset = decode_image(bytes, name)?;
    let directory = asset_directory(root, true)?; let path = directory.join(&asset.asset_id);
    if fs::symlink_metadata(&path).is_ok() {
        if read_image(root, &asset.asset_id)?.1 != bytes { return Err(error("assetMismatch")); }
        return Ok(asset);
    }
    atomic_write(&path, bytes, false)?;
    Ok(asset)
}

pub(crate) fn read_image(root: &Path, id: &str) -> Result<(ImageAsset, Vec<u8>), String> {
    validate_asset_id(id)?;
    let directory = asset_directory(root, false)?; let path = directory.join(id);
    if !path.canonicalize().map_err(io_error)?.starts_with(directory.canonicalize().map_err(io_error)?) { return Err(error("unsafePath")); }
    let bytes = bounded_read(&path, MAX_IMAGE_BYTES, false)?; let asset = decode_image(&bytes, id)?;
    if asset.asset_id != id { return Err(error("assetMismatch")); }
    Ok((asset, bytes))
}

fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    let directory = path.parent().ok_or_else(|| error("unsafePath"))?;
    let temp = directory.join(format!(".kkb-write-{}-{}.tmp", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?; file.sync_all().map_err(io_error)?; drop(file);
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if !replace || linked(&metadata) || !metadata.is_file() { return Err(error("unsafePath")); }
        }
        fs::rename(&temp, path).map_err(io_error)?;
        // Opening directories is unsupported on Windows. File durability still precedes refs.
        #[cfg(not(windows))] File::open(directory).map_err(io_error)?.sync_all().map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); } result
}

#[tauri::command]
pub async fn import_image_assets(app: tauri::AppHandle, window: tauri::WebviewWindow, inputs: Vec<ImageInput>) -> Result<Vec<ImageAsset>, String> {
    crate::desktop::require_main(&window)?;
    let root = crate::desktop::root(&app)?;
    run_image_work(move || import_images(&root, inputs)).await
}

fn import_images(root: &Path, inputs: Vec<ImageInput>) -> Result<Vec<ImageAsset>, String> {
    if inputs.is_empty() || inputs.len() > 64 { return Err(error("tooMany")); }
    let mut images = Vec::with_capacity(inputs.len()); let mut total = 0usize;
    for input in inputs {
        let name = checked_name(&input.name)?;
        let bytes = match (input.base64, input.path) {
            (Some(encoded), None) => {
                if encoded.len() > ((MAX_IMAGE_BYTES + 2) / 3) * 4 { return Err(error("tooLarge")); }
                base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| error("invalidInput"))?
            }
            (None, Some(path)) => bounded_read(Path::new(&path), MAX_IMAGE_BYTES, true)?,
            _ => return Err(error("invalidInput")),
        };
        total = total.checked_add(bytes.len()).ok_or_else(|| error("tooLarge"))?;
        if total > MAX_BATCH_BYTES { return Err(error("tooLarge")); }
        images.push(store_image(root, &bytes, &name)?);
    }
    Ok(images)
}

#[tauri::command]
pub async fn read_image_asset(app: tauri::AppHandle, window: tauri::WebviewWindow, asset_id: String) -> Result<String, String> {
    if window.label() != "main" && crate::card_of_label(window.label()).filter(|id| !id.is_empty()).is_none() { return Err(error("invalidWindow")); }
    let root = crate::desktop::root(&app)?;
    run_image_work(move || {
        let (asset, bytes) = read_image(&root, &asset_id)?;
        Ok(format!("data:{};base64,{}", asset.mime, base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await
}

fn verify_images(root: &Path, asset_ids: Vec<String>) -> Result<Vec<ImageAsset>, String> {
    if asset_ids.len() > 64 { return Err(error("tooMany")); }
    asset_ids.into_iter().map(|id| read_image(root, &id).map(|(asset, _)| asset)).collect()
}

fn preview_image(root: &Path, id: &str, max_side: u32) -> Result<Vec<u8>, String> {
    let (_, bytes) = read_image(root, id)?;
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(io_error)?;
    reader.limits(image_limits());
    let mut decoder = reader.into_decoder().map_err(|_| error("invalidImage"))?;
    let orientation = decoder.orientation().map_err(|_| error("invalidImage"))?;
    // Mirror ImageReader::decode's output-allocation reservation before using from_decoder.
    let mut limits = image_limits();
    limits.reserve(decoder.total_bytes()).map_err(|_| error("dimensions"))?;
    decoder.set_limits(limits).map_err(|_| error("dimensions"))?;
    let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(|_| error("invalidImage"))?;
    decoded.apply_orientation(orientation);
    let max_side = max_side.clamp(128, 2048);
    let preview = if decoded.width() > max_side || decoded.height() > max_side {
        decoded.thumbnail(max_side, max_side)
    } else { decoded };
    let mut encoded = Cursor::new(Vec::new());
    preview.write_to(&mut encoded, ImageFormat::Png).map_err(|_| error("invalidImage"))?;
    Ok(encoded.into_inner())
}

#[tauri::command]
pub async fn read_image_preview(app: tauri::AppHandle, window: tauri::WebviewWindow, asset_id: String, max_side: Option<u32>) -> Result<String, String> {
    if window.label() != "main" && crate::card_of_label(window.label()).filter(|id| !id.is_empty()).is_none() { return Err(error("invalidWindow")); }
    let root = crate::desktop::root(&app)?;
    run_image_work(move || {
        let bytes = preview_image(&root, &asset_id, max_side.unwrap_or(512))?;
        Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await
}

#[tauri::command]
pub async fn verify_image_assets(app: tauri::AppHandle, window: tauri::WebviewWindow, asset_ids: Vec<String>) -> Result<Vec<ImageAsset>, String> {
    crate::desktop::require_main(&window)?;
    let root = crate::desktop::root(&app)?;
    run_image_work(move || verify_images(&root, asset_ids)).await
}

fn checked_share_path(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("kkbpack")) {
        return Err(error("shareInvalidPath"));
    }
    Ok(path)
}

#[tauri::command]
pub async fn save_share_package(app: tauri::AppHandle, window: tauri::WebviewWindow, data: String, name: String) -> Result<bool, String> {
    crate::desktop::require_main(&window)?;
    if data.len() > MAX_BATCH_BYTES { return Err(error("shareTooLarge")); }
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let name = checked_name(&name)?;
        let selected = app.dialog().file().set_parent(&window).set_title(error("saveShareTitle"))
            .set_file_name(name).add_filter(error("shareFilter"), &["kkbpack"]).blocking_save_file();
        let Some(selected) = selected else { return Ok(false); };
        let path = checked_share_path(selected.into_path().map_err(io_error)?)?;
        let parent = path.parent().ok_or_else(|| error("shareInvalidPath"))?;
        if !parent.is_dir() || linked(&fs::symlink_metadata(parent).map_err(io_error)?) { return Err(error("shareInvalidPath")); }
        atomic_write(&path, data.as_bytes(), true)?; Ok(true)
    }).await.map_err(io_error)?
}

#[tauri::command]
pub async fn pick_share_package(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    crate::desktop::require_main(&window)?;
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app.dialog().file().set_parent(&window).set_title(error("openShareTitle"))
            .add_filter(error("shareFilter"), &["kkbpack"]).blocking_pick_file();
        let Some(selected) = selected else { return Ok(None); };
        let path = selected.into_path().map_err(io_error)?;
        let metadata = fs::metadata(&path).map_err(io_error)?;
        if metadata.len() > MAX_BATCH_BYTES as u64 { return Err(error("shareTooLarge")); }
        let bytes = bounded_read(&path, MAX_BATCH_BYTES, true)?;
        Ok(Some(String::from_utf8(bytes).map_err(|_| error("shareUtf8"))?))
    }).await.map_err(io_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Cursor, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("kkb-image-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&dir).unwrap(); Self(dir)
        }
    }
    impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(3, 2, image::Rgba([12, 99, 80, 100])))
            .write_to(&mut bytes, image::ImageFormat::Png).unwrap(); bytes.into_inner()
    }

    #[test]
    fn asset_ids_allow_only_content_hash_and_raster_extension() {
        let hash = "a".repeat(64);
        assert!(validate_asset_id(&format!("{hash}.png")).is_ok());
        for id in [format!("../{hash}.png"), format!("{hash}.svg"), format!("{}.PNG", "A".repeat(64)), format!("{hash}.png/extra")] {
            assert!(validate_asset_id(&id).is_err());
        }
    }

    #[test]
    fn import_uses_actual_format_and_deduplicates_while_preserving_bytes() {
        let dir = TestDir::new(); let bytes = png();
        let asset = store_image(&dir.0, &bytes, "fake.svg").unwrap();
        assert_eq!((asset.mime.as_str(), asset.width, asset.height), ("image/png", 3, 2));
        assert!(asset.asset_id.ends_with(".png"));
        assert_eq!(store_image(&dir.0, &bytes, "another.png").unwrap().asset_id, asset.asset_id);
        assert_eq!(read_image(&dir.0, &asset.asset_id).unwrap().1, bytes);
        assert_eq!(fs::read_dir(dir.0.join(".kkb/assets/images")).unwrap().count(), 1);
    }

    #[test]
    fn rejects_truncated_raster_and_non_raster() {
        let dir = TestDir::new();
        let bytes = png();
        assert!(store_image(&dir.0, &bytes[..32], "broken.png").is_err());
        assert!(store_image(&dir.0, b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "x.png").is_err());
        assert!(!dir.0.join(".kkb/assets/images").exists());
    }

    #[test]
    fn reused_hash_must_match_stored_file_not_merely_file_name() {
        let dir = TestDir::new(); let bytes = png();
        let asset = store_image(&dir.0, &bytes, "ok.png").unwrap();
        fs::write(dir.0.join(".kkb/assets/images").join(&asset.asset_id), b"corrupted").unwrap();
        assert!(store_image(&dir.0, &bytes, "ok.png").is_err());
        assert!(read_image(&dir.0, &asset.asset_id).is_err());
    }

    #[test]
    fn rejects_over_limit_dimensions_before_storage() {
        let dir = TestDir::new(); let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageLuma8(image::GrayImage::new(16_385, 1)).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        assert!(store_image(&dir.0, &bytes.into_inner(), "wide.png").is_err());
        assert!(!dir.0.join(".kkb/assets/images").exists());
    }

    #[test]
    fn imports_recognized_jpeg_webp_and_gif_regardless_of_name() {
        let dir = TestDir::new();
        for (format, mime, ext) in [(image::ImageFormat::Jpeg, "image/jpeg", "jpg"), (image::ImageFormat::WebP, "image/webp", "webp"), (image::ImageFormat::Gif, "image/gif", "gif")] {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 2, image::Rgb([12, 99, 80]))).write_to(&mut bytes, format).unwrap();
            let asset = store_image(&dir.0, &bytes.into_inner(), "image.png").unwrap();
            assert_eq!(asset.mime, mime); assert!(asset.asset_id.ends_with(ext));
            assert_eq!((asset.width, asset.height), (3, 2));
        }
    }

    #[test]
    fn base64_and_external_files_obey_same_validated_import_contract() {
        let dir = TestDir::new(); let bytes = png();
        let external = dir.0.join("image.bin"); fs::write(&external, &bytes).unwrap();
        let images = import_images(&dir.0, vec![
            ImageInput { name: "paste.png".into(), base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)), path: None },
            ImageInput { name: "drag.png".into(), base64: None, path: Some(external.to_string_lossy().into()) },
        ]).unwrap();
        assert_eq!(images[0].asset_id, images[1].asset_id);
        assert!(import_images(&dir.0, vec![ImageInput { name: "x".into(), base64: Some("!".into()), path: None }]).is_err());
        assert!(import_images(&dir.0, vec![ImageInput { name: "x".into(), base64: Some("aA==".into()), path: Some("image.png".into()) }]).is_err());
        assert!(import_images(&dir.0, vec![ImageInput { name: "x".into(), base64: None, path: Some("image.png".into()) }]).is_err());
        assert!(import_images(&dir.0, vec![]).is_err());
    }

    #[test]
    fn refuses_files_in_asset_directory() {
        let dir = TestDir::new(); fs::create_dir(dir.0.join(".kkb")).unwrap();
        fs::write(dir.0.join(".kkb/assets"), b"not a directory").unwrap();
        assert!(store_image(&dir.0, &png(), "x.png").is_err());
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            let metadata = fs::metadata(dir.0.join(".kkb/assets")).unwrap();
            assert!(!linked(&metadata)); assert_eq!(metadata.file_attributes() & 0x400, 0);
        }
    }

    #[test]
    fn bounded_reads_and_atomic_replacement_keep_existing_content_safe() {
        let dir = TestDir::new(); let path = dir.0.join("shared.kkbpack");
        fs::write(&path, b"old").unwrap();
        assert!(atomic_write(&path, b"new", false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        atomic_write(&path, b"replacement", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert!(bounded_read(&path, 3, true).is_err());
        let folder = dir.0.join("folder"); fs::create_dir(&folder).unwrap();
        assert!(atomic_write(&folder, b"danger", true).is_err());
        assert!(folder.is_dir());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn metadata_verification_requires_existing_hash_checked_images() {
        let dir = TestDir::new(); let asset = store_image(&dir.0, &png(), "x.png").unwrap();
        let result = verify_images(&dir.0, vec![asset.asset_id.clone()]).unwrap();
        assert_eq!(result.len(), 1); assert_eq!(result[0].mime, "image/png");
        assert!(verify_images(&dir.0, vec![format!("{}.png", "f".repeat(64))]).is_err());
        assert!(verify_images(&dir.0, vec![asset.asset_id; 65]).is_err());
        assert!(verify_images(&dir.0, vec![]).unwrap().is_empty());
    }

    #[test]
    fn decode_work_is_shared_and_never_runs_more_than_two_jobs() {
        use std::sync::{Arc, atomic::AtomicUsize};
        let active = Arc::new(AtomicUsize::new(0)); let peak = Arc::new(AtomicUsize::new(0));
        tauri::async_runtime::block_on(async {
            let mut tasks = Vec::new();
            for _ in 0..8 {
                let active = Arc::clone(&active); let peak = Arc::clone(&peak);
                tasks.push(tauri::async_runtime::spawn(async move {
                    run_image_work(move || {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1; peak.fetch_max(count, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(25));
                        active.fetch_sub(1, Ordering::SeqCst); Ok(())
                    }).await.unwrap();
                }));
            }
            for task in tasks { task.await.unwrap(); }
        });
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert!(peak.load(Ordering::SeqCst) <= 2, "peak={}", peak.load(Ordering::SeqCst));
    }

    #[test]
    fn previews_preserve_aspect_ratio_alpha_and_original_asset_bytes() {
        let dir = TestDir::new(); let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(1024, 512, image::Rgba([12, 99, 80, 100])))
            .write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let bytes = bytes.into_inner(); let asset = store_image(&dir.0, &bytes, "large.png").unwrap();
        let preview = preview_image(&dir.0, &asset.asset_id, 512).unwrap();
        let decoded = image::load_from_memory(&preview).unwrap().into_rgba8();
        assert_eq!(decoded.dimensions(), (512, 256));
        assert_eq!(decoded.get_pixel(120, 120).0, [12, 99, 80, 100]);
        assert_eq!(read_image(&dir.0, &asset.asset_id).unwrap().1, bytes);
    }

    #[test]
    fn previews_do_not_enlarge_small_images_and_reencode_raster_as_png() {
        let dir = TestDir::new(); let small = store_image(&dir.0, &png(), "small.png").unwrap();
        let preview = preview_image(&dir.0, &small.asset_id, 512).unwrap();
        assert_eq!(image::load_from_memory(&preview).unwrap().into_rgba8().dimensions(), (3, 2));
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(320, 160, image::Rgb([12, 99, 80])))
            .write_to(&mut bytes, image::ImageFormat::Jpeg).unwrap();
        let asset = store_image(&dir.0, &bytes.into_inner(), "source.jpg").unwrap();
        assert_eq!(image::guess_format(&preview_image(&dir.0, &asset.asset_id, 128).unwrap()).unwrap(), image::ImageFormat::Png);
    }

    #[test]
    fn animated_gif_preview_uses_first_frame_without_rewriting_animation() {
        let dir = TestDir::new(); let mut bytes = Cursor::new(Vec::new());
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder.encode_frames([
                image::Frame::new(image::RgbaImage::from_pixel(16, 8, image::Rgba([255, 0, 0, 255]))),
                image::Frame::new(image::RgbaImage::from_pixel(16, 8, image::Rgba([0, 0, 255, 255]))),
            ]).unwrap();
        }
        let bytes = bytes.into_inner(); let asset = store_image(&dir.0, &bytes, "animation.gif").unwrap();
        let preview = preview_image(&dir.0, &asset.asset_id, 512).unwrap();
        assert_eq!(image::guess_format(&preview).unwrap(), image::ImageFormat::Png);
        assert_eq!(image::load_from_memory(&preview).unwrap().into_rgba8().get_pixel(0, 0).0, [255, 0, 0, 255]);
        let (metadata, original) = read_image(&dir.0, &asset.asset_id).unwrap();
        assert_eq!(metadata.mime, "image/gif"); assert_eq!(original, bytes);
    }

    #[test]
    fn jpeg_exif_orientation_is_applied_only_to_derived_preview() {
        let dir = TestDir::new();
        let source = image::RgbImage::from_fn(80, 40, |x, _y| if x < 40 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) });
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(source).write_to(&mut encoded, ImageFormat::Jpeg).unwrap();
        let original = encoded.into_inner(); assert_eq!(&original[..2], &[0xff, 0xd8]);
        // A real APP1 Exif/TIFF IFD with Orientation=6 (90 degrees clockwise).
        let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut oriented = original[..2].to_vec(); oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes()); oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&original[2..]);
        let mut decoder = ImageReader::with_format(Cursor::new(&oriented), ImageFormat::Jpeg).into_decoder().unwrap();
        assert_eq!(decoder.orientation().unwrap(), image::metadata::Orientation::Rotate90);
        let asset = store_image(&dir.0, &oriented, "phone.jpg").unwrap();
        assert_eq!((asset.width, asset.height), (80, 40));
        let preview = image::load_from_memory(&preview_image(&dir.0, &asset.asset_id, 512).unwrap()).unwrap().into_rgb8();
        assert_eq!(preview.dimensions(), (40, 80));
        let top = preview.get_pixel(20, 10); let bottom = preview.get_pixel(20, 70);
        assert!(top[0] > 200 && top[2] < 40); assert!(bottom[2] > 200 && bottom[0] < 40);
        let (raw, bytes) = read_image(&dir.0, &asset.asset_id).unwrap();
        assert_eq!((raw.width, raw.height), (80, 40)); assert_eq!(bytes, oriented);
        assert_eq!(raw.asset_id, asset.asset_id);
    }

    #[test]
    fn share_save_path_must_preserve_exact_selected_target() {
        let dir = TestDir::new();
        let existing = dir.0.join("foo.kkbpack"); fs::write(&existing, b"existing package").unwrap();
        let wrong_extension = dir.0.join("foo.json");
        assert!(checked_share_path(wrong_extension).is_err());
        assert!(checked_share_path(dir.0.join("foo")).is_err());
        assert!(checked_share_path(PathBuf::from("relative.kkbpack")).is_err());
        for name in ["file.kkbpack", "file.KKBPACK", "file.KkbPack"] {
            let selected = dir.0.join(name); assert_eq!(checked_share_path(selected.clone()).unwrap(), selected);
        }
        assert_eq!(fs::read(&existing).unwrap(), b"existing package");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}
