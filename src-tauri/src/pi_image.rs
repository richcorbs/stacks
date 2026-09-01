use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::Serialize;
use std::{io::Cursor, path::Path};

const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ENCODED_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIMENSION: u32 = 1600;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiImage {
    data: String,
    mime_type: String,
    name: String,
    byte_size: usize,
}

#[tauri::command]
pub fn read_pi_image(path: String) -> Result<PiImage, String> {
    let path = Path::new(&path);
    let metadata = std::fs::metadata(path).map_err(|error| format!("Could not read image: {error}"))?;
    if !metadata.is_file() {
        return Err("Dropped image is not a file".to_string());
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err("Image is larger than 20 MB".to_string());
    }

    let bytes = std::fs::read(path).map_err(|error| format!("Could not read image: {error}"))?;
    let format = image::guess_format(&bytes).map_err(|_| "Unsupported or invalid image data".to_string())?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP | ImageFormat::Bmp) {
        return Err("Unsupported image type".to_string());
    }
    let decoded = image::load_from_memory_with_format(&bytes, format)
        .map_err(|error| format!("Could not decode image: {error}"))?;
    let resized = resize_image(decoded);
    // Normalize to JPEG to bound IPC/session memory and avoid retaining a full
    // source image merely for a composer thumbnail.
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(resized.to_rgb8())
        .write_to(&mut encoded, ImageFormat::Jpeg)
        .map_err(|error| format!("Could not prepare image: {error}"))?;
    let encoded = encoded.into_inner();
    if encoded.len() > MAX_ENCODED_BYTES {
        return Err("Prepared image is larger than 2 MB; use a smaller image".to_string());
    }

    Ok(PiImage {
        data: STANDARD.encode(&encoded),
        mime_type: "image/jpeg".to_string(),
        name: path.file_name().and_then(|name| name.to_str()).unwrap_or("image").to_string(),
        byte_size: encoded.len(),
    })
}

fn resize_image(image: DynamicImage) -> DynamicImage {
    let (width, height) = image.dimensions();
    if width <= MAX_DIMENSION && height <= MAX_DIMENSION { image }
    else { image.thumbnail(MAX_DIMENSION, MAX_DIMENSION) }
}

#[cfg(test)]
mod tests {
    use super::resize_image;
    use image::{DynamicImage, GenericImageView, RgbImage};

    #[test]
    fn bounds_large_image_dimensions() {
        let image = DynamicImage::ImageRgb8(RgbImage::new(3200, 800));
        let resized = resize_image(image);
        assert_eq!(resized.dimensions(), (1600, 400));
    }
}
