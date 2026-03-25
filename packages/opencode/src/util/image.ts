import { Log } from "./log"
import { GodotImage } from "./godot-image"

const log = Log.create({ service: "image" })

// Anthropic API limit is 5 MB for the base64 string.
// base64 inflates ~33%, so 3.7 MB raw -> ~4.93 MB base64 (safely under 5 MB).
const MAX_IMAGE_BYTES = 3.7 * 1024 * 1024

/**
 * Compress a base64-encoded image if it exceeds the API size limit.
 * Returns { data, mime } with possibly re-encoded JPEG data and updated mime type.
 * Uses Godot's native Image class via command queue (non-blocking).
 *
 * For GIFs: extracts the first frame as a static JPEG since GIF animation
 * cannot be preserved through JPEG re-encoding, and animated GIFs that exceed
 * the limit would break the entire session if left uncompressed.
 */
export async function compressImageBase64(base64Data: string, mime: string): Promise<{ data: string; mime: string } | null> {
  const buf = Buffer.from(base64Data, "base64")
  if (buf.length <= MAX_IMAGE_BYTES) return { data: base64Data, mime }

  // GIFs can't be compressed via Godot's Image class (it doesn't support GIF loading)
  // Drop them immediately to avoid spamming Godot with image format errors
  if (mime === "image/gif") {
    log.warn("oversized GIF dropped (Godot cannot compress GIFs)", { sizeKB: Math.round(buf.length / 1024) })
    return null
  }

  log.info("compressing oversized image", {
    originalKB: Math.round(buf.length / 1024),
    maxKB: Math.round(MAX_IMAGE_BYTES / 1024),
    mime,
  })

  try {
    const result = await GodotImage.compress(buf, MAX_IMAGE_BYTES)
    const compressed = result.data.toString("base64")
    // Verify the compressed result is actually under the limit
    if (Buffer.from(compressed, "base64").length <= MAX_IMAGE_BYTES) {
      return { data: compressed, mime: result.mime }
    }
    log.warn("compressed image still too large, dropping", { mime, sizeKB: Math.round(buf.length / 1024) })
    return null
  } catch {
    // If compression fails, drop the image rather than sending an oversized one that breaks the session
    log.warn("image compression failed, dropping image", { mime, sizeKB: Math.round(buf.length / 1024) })
    return null
  }
}

/**
 * Compress a data URL (data:mime;base64,...) if the image exceeds the API size limit.
 * Returns the (possibly compressed) data URL.
 */
export async function compressDataUrl(dataUrl: string): Promise<{ url: string; mime: string } | null> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return { url: dataUrl, mime: "" }

  const [, mime, base64Data] = match
  if (!mime.startsWith("image/")) return { url: dataUrl, mime }

  const result = await compressImageBase64(base64Data, mime)
  if (!result) return null
  return {
    url: `data:${result.mime};base64,${result.data}`,
    mime: result.mime,
  }
}
