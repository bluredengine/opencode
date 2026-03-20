import { GodotCommands, GodotImageProcessResults, GodotAtlasSplitResults } from "../server/routes/godot"
import { Instance } from "../project/instance"
import { Log } from "./log"

const log = Log.create({ service: "godot-image" })

export interface ImageOperation {
  op: "metadata" | "resize" | "trim" | "crop" | "pad" | "format" | "decode_rgba"
  [key: string]: unknown
}

export interface ImageProcessResult {
  data: string // base64-encoded output
  metadata: {
    width: number
    height: number
    format?: string
    mime?: string
    trimOffsetLeft?: number
    trimOffsetTop?: number
  }
}

const POLL_INTERVAL = 100
const POLL_TIMEOUT = 30_000

async function pollForResult(id: string, timeoutMs = POLL_TIMEOUT): Promise<ImageProcessResult> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = GodotImageProcessResults.get(id)
    if (result) {
      if (result.error) {
        throw new Error(`Godot image_process error: ${result.error}`)
      }
      const meta = result.metadata as ImageProcessResult["metadata"]
      return { data: result.data!, metadata: meta }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }
  throw new Error(`image_process timed out after ${timeoutMs}ms`)
}

/**
 * Route image operations through Godot's native Image class via command queue.
 * All processing runs on Godot's WorkerThreadPool (non-blocking).
 */
export namespace GodotImage {
  /**
   * Run a pipeline of image operations in a single round-trip to Godot.
   * Input can be base64 data or a file path on disk.
   */
  export async function pipeline(
    input: { base64: string } | { path: string },
    ops: ImageOperation[],
    timeoutMs = POLL_TIMEOUT,
  ): Promise<ImageProcessResult> {
    const id = crypto.randomUUID()
    const directory = Instance.directory

    const params: Record<string, unknown> = { id, ops }
    if ("base64" in input) {
      params.input = input.base64
    } else {
      params.input_path = input.path
    }

    GodotCommands.push(directory, "image_process", params)
    log.info("queued image_process", { id, ops: ops.map((o) => o.op) })

    return pollForResult(id, timeoutMs)
  }

  /**
   * Get image dimensions. Uses pure-JS PNG/JPEG header parsing when possible,
   * falls back to Godot for other formats.
   */
  export async function metadata(buf: Buffer): Promise<{ width: number; height: number }> {
    // Try pure-JS header parsing first (no Godot round-trip needed)
    const dims = parseImageDimensions(buf)
    if (dims) return dims

    // Fall back to Godot
    const result = await pipeline({ base64: buf.toString("base64") }, [{ op: "metadata" }])
    return { width: result.metadata.width, height: result.metadata.height }
  }

  /**
   * Decode an image to raw RGBA pixel data via Godot.
   */
  export async function decodeToRGBA(
    buf: Buffer,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const result = await pipeline({ base64: buf.toString("base64") }, [{ op: "decode_rgba" }])
    return {
      data: Buffer.from(result.data, "base64"),
      width: result.metadata.width,
      height: result.metadata.height,
    }
  }

  /**
   * Compress an image by resizing + JPEG encoding via Godot.
   */
  export async function compress(
    buf: Buffer,
    maxBytes: number,
    opts?: { minWidth?: number },
  ): Promise<{ data: Buffer; mime: string }> {
    const meta = await metadata(buf)
    if (!meta.width || !meta.height) return { data: buf, mime: "image/png" }

    for (let scale = 0.75; scale >= 0.15; scale -= 0.1) {
      const w = Math.max(1, Math.round(meta.width * scale))
      const h = Math.max(1, Math.round(meta.height * scale))
      const result = await pipeline({ base64: buf.toString("base64") }, [
        { op: "resize", width: w, height: h, fit: "inside" },
        { op: "format", to: "jpeg", quality: 0.85 },
      ])
      const outBuf = Buffer.from(result.data, "base64")
      if (outBuf.length <= maxBytes) {
        log.info("image compressed via Godot", {
          originalKB: Math.round(buf.length / 1024),
          compressedKB: Math.round(outBuf.length / 1024),
          scale: Math.round(scale * 100) + "%",
        })
        return { data: outBuf, mime: "image/jpeg" }
      }
    }

    // Last resort
    const minW = opts?.minWidth ?? 512
    const result = await pipeline({ base64: buf.toString("base64") }, [
      { op: "resize", width: minW, height: minW, fit: "inside" },
      { op: "format", to: "jpeg", quality: 0.7 },
    ])
    log.warn("image heavily compressed via Godot", {
      originalKB: Math.round(buf.length / 1024),
      compressedKB: Math.round(Buffer.from(result.data, "base64").length / 1024),
    })
    return { data: Buffer.from(result.data, "base64"), mime: "image/jpeg" }
  }
}

export interface AtlasSplitRegion {
  index: number
  rect: { x: number; y: number; width: number; height: number }
  area: number
  /** base64-encoded cropped PNG */
  data: string
}

export interface AtlasSplitOptions {
  minArea?: number
  dilationKernel?: number
  dilationIterations?: number
  padding?: number
  bgMode?: "alpha" | "white" | "black"
}

const ATLAS_POLL_TIMEOUT = 60_000

/**
 * Route atlas splitting through Godot's connected-component labeling via command queue.
 */
export namespace GodotAtlasSplit {
  export async function split(
    input: { base64: string } | { path: string },
    options?: AtlasSplitOptions,
    timeoutMs = ATLAS_POLL_TIMEOUT,
  ): Promise<AtlasSplitRegion[]> {
    const id = crypto.randomUUID()
    const directory = Instance.directory

    const params: Record<string, unknown> = {
      id,
      min_area: options?.minArea ?? 100,
      kernel_size: options?.dilationKernel ?? 5,
      iterations: options?.dilationIterations ?? 2,
      padding: options?.padding ?? 2,
      bg_mode: options?.bgMode ?? "alpha",
    }
    if ("base64" in input) {
      params.input = input.base64
    } else {
      params.input_path = input.path
    }

    GodotCommands.push(directory, "atlas_split", params)
    log.info("queued atlas_split", { id })

    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const result = GodotAtlasSplitResults.get(id)
      if (result) {
        if (result.error) {
          throw new Error(`Godot atlas_split error: ${result.error}`)
        }
        return (result.regions ?? []) as AtlasSplitRegion[]
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
    }
    throw new Error(`atlas_split timed out after ${timeoutMs}ms`)
  }
}

/**
 * Pure-JS image dimension parsing (no dependencies).
 * Reads PNG IHDR or JPEG SOF markers to extract width/height.
 */
function parseImageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null

  // PNG: first 8 bytes are signature, then IHDR chunk at offset 16 has width(4) + height(4)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    return { width, height }
  }

  // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      if (marker === 0xc0 || marker === 0xc2) {
        const height = buf.readUInt16BE(offset + 5)
        const width = buf.readUInt16BE(offset + 7)
        return { width, height }
      }
      // Skip to next marker
      const segLen = buf.readUInt16BE(offset + 2)
      offset += 2 + segLen
    }
  }

  return null
}
