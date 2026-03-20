import { Log } from "./log"
import { GodotImage } from "./godot-image"

const log = Log.create({ service: "image" })

// 4.5 MB raw bytes — base64 encoding inflates ~33%, keeping well under Anthropic's 5 MB limit
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024

/**
 * Compress a base64-encoded image if it exceeds the API size limit.
 * Returns { data, mime } with possibly re-encoded JPEG data and updated mime type.
 * Uses Godot's native Image class via command queue (non-blocking).
 */
export async function compressImageBase64(base64Data: string, mime: string): Promise<{ data: string; mime: string }> {
  const buf = Buffer.from(base64Data, "base64")
  if (buf.length <= MAX_IMAGE_BYTES) return { data: base64Data, mime }

  try {
    const result = await GodotImage.compress(buf, MAX_IMAGE_BYTES)
    return { data: result.data.toString("base64"), mime: result.mime }
  } catch {
    return { data: base64Data, mime }
  }
}

/**
 * Compress a data URL (data:mime;base64,...) if the image exceeds the API size limit.
 * Returns the (possibly compressed) data URL.
 */
export async function compressDataUrl(dataUrl: string): Promise<{ url: string; mime: string }> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return { url: dataUrl, mime: "" }

  const [, mime, base64Data] = match
  if (!mime.startsWith("image/")) return { url: dataUrl, mime }

  const result = await compressImageBase64(base64Data, mime)
  return {
    url: `data:${result.mime};base64,${result.data}`,
    mime: result.mime,
  }
}
