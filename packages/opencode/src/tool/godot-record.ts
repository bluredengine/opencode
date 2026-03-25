import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands, GodotRecordResults } from "../server/routes/godot"
import { Identifier } from "../id/id"
import type { MessageV2 } from "../session/message-v2"
const DESCRIPTION = `Retrieve the last GIF recording from the Godot game viewport.

The user toggles GIF recording with **F1** in the Godot editor while the game is running.
When recording stops, the captured frames are sent to this tool's backend.

Use this tool to:
- Retrieve and analyze the last viewport recording as an animated GIF
- Verify animations, transitions, drag effects, or any temporal game behavior
- Compare visual states across multiple frames

The tool encodes the captured PNG frames into an animated GIF and returns it as an image attachment.
If no recording is available, it will return an error.`

async function pollForRecordResult(id: string, timeoutMs: number): Promise<string[]> {
  const start = Date.now()
  const interval = 500
  while (Date.now() - start < timeoutMs) {
    const frames = GodotRecordResults.get(id)
    if (frames) return frames
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`Recording poll timed out after ${timeoutMs}ms.`)
}

// Parse raw RGBA frame: 8-byte header (uint32 LE width + uint32 LE height) + RGBA pixels.
function tryParseRawRGBA(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | null {
  if (buf.length < 8) return null
  const width = buf.readUInt32LE(0)
  const height = buf.readUInt32LE(4)
  if (buf.length !== 8 + width * height * 4) return null
  return { width, height, rgba: new Uint8Array(buf.buffer, buf.byteOffset + 8, width * height * 4) }
}

async function encodeFramesToGif(base64Frames: string[], fps: number): Promise<string> {
  const { GIFEncoder, quantize, applyPalette } = await import("../util/gifenc")

  const gif = GIFEncoder()
  const delay = Math.round(1000 / fps)
  let width = 0
  let height = 0

  // Detect format from first frame
  const firstBuf = Buffer.from(base64Frames[0], "base64")
  const firstRaw = tryParseRawRGBA(firstBuf)

  if (firstRaw) {
    // Fast path: raw RGBA frames -- no decoding needed.
    width = firstRaw.width
    height = firstRaw.height
    const palette = quantize(firstRaw.rgba, 256)
    const indexed = applyPalette(firstRaw.rgba, palette)
    gif.writeFrame(indexed, width, height, { palette, delay })

    for (let i = 1; i < base64Frames.length; i++) {
      const buf = Buffer.from(base64Frames[i], "base64")
      const parsed = tryParseRawRGBA(buf)
      if (!parsed) continue
      const pal = quantize(parsed.rgba, 256)
      const idx = applyPalette(parsed.rgba, pal)
      gif.writeFrame(idx, width, height, { palette: pal, delay })
    }
  } else {
    // Legacy path: PNG frames -- decode via Godot.
    const { GodotImage } = await import("../util/godot-image")
    const firstDecoded = await GodotImage.decodeToRGBA(firstBuf)
    width = firstDecoded.width
    height = firstDecoded.height
    const rgba = new Uint8Array(firstDecoded.data)
    const palette = quantize(rgba, 256)
    const indexed = applyPalette(rgba, palette)
    gif.writeFrame(indexed, width, height, { palette, delay })

    for (let i = 1; i < base64Frames.length; i++) {
      const buf = Buffer.from(base64Frames[i], "base64")
      const decoded = await GodotImage.decodeToRGBA(buf)
      const r = new Uint8Array(decoded.data)
      const pal = quantize(r, 256)
      const idx = applyPalette(r, pal)
      gif.writeFrame(idx, width, height, { palette: pal, delay })
    }
  }

  gif.finish()
  const gifBytes = gif.bytes()
  return Buffer.from(gifBytes).toString("base64")
}

/**
 * Downscale raw RGBA frames by the given factor.
 * Only works with raw RGBA format (8-byte header + RGBA pixels).
 * Returns null if frames aren't in raw RGBA format.
 */
function downscaleFrames(frames: string[], scale: number): string[] | null {
  const result: string[] = []
  for (const frame of frames) {
    const buf = Buffer.from(frame, "base64")
    const parsed = tryParseRawRGBA(buf)
    if (!parsed) return null // can't downscale non-raw frames

    const { width, height, rgba } = parsed
    const newW = Math.max(1, Math.round(width * scale))
    const newH = Math.max(1, Math.round(height * scale))
    const out = new Uint8Array(newW * newH * 4)

    for (let y = 0; y < newH; y++) {
      const srcY = Math.min(Math.round(y / scale), height - 1)
      for (let x = 0; x < newW; x++) {
        const srcX = Math.min(Math.round(x / scale), width - 1)
        const srcIdx = (srcY * width + srcX) * 4
        const dstIdx = (y * newW + x) * 4
        out[dstIdx] = rgba[srcIdx]
        out[dstIdx + 1] = rgba[srcIdx + 1]
        out[dstIdx + 2] = rgba[srcIdx + 2]
        out[dstIdx + 3] = rgba[srcIdx + 3]
      }
    }

    // Re-encode with 8-byte header
    const outBuf = Buffer.alloc(8 + out.length)
    outBuf.writeUInt32LE(newW, 0)
    outBuf.writeUInt32LE(newH, 4)
    outBuf.set(out, 8)
    result.push(outBuf.toString("base64"))
  }
  return result
}

export const GodotRecordTool = Tool.define("godot_record", {
  description: DESCRIPTION,
  parameters: z.object({
    recording_id: z
      .string()
      .optional()
      .describe("The recording ID to retrieve. If omitted, triggers a new recording request via the command queue."),
    duration_ms: z
      .number()
      .int()
      .min(500)
      .max(10000)
      .default(3000)
      .describe("Duration to record in milliseconds (only used when triggering a new recording)."),
    fps: z
      .number()
      .int()
      .min(2)
      .max(15)
      .default(8)
      .describe("Frames per second for the recording."),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory

    // If no recording_id, trigger a new recording via command queue
    const id = params.recording_id ?? crypto.randomUUID()
    if (!params.recording_id) {
      GodotCommands.push(directory, "record", {
        id,
        duration_ms: params.duration_ms,
        fps: params.fps,
      })
    }

    ctx.metadata({ title: `Recording ${params.duration_ms}ms at ${params.fps}fps...` })

    let frames: string[]
    try {
      // Wait for recording to complete (duration + buffer for processing)
      frames = await pollForRecordResult(id, params.duration_ms + 15_000)
    } catch (err: any) {
      return {
        title: "Recording failed",
        metadata: { error: err.message },
        output: `Recording failed: ${err.message}\n\nMake sure the game is running. You can also press F1 in the editor to manually record, then call this tool to retrieve it.`,
      }
    }

    if (frames.length === 0) {
      return {
        title: "No frames captured",
        metadata: {},
        output: "Recording completed but no frames were captured. Make sure the game is running in embedded mode.",
      }
    }

    // Encode frames to animated GIF, with size limits for the API
    // Anthropic API has a 5MB base64 limit per image (~3.75MB raw)
    const MAX_GIF_BASE64_BYTES = 4.8 * 1024 * 1024
    const MIN_DIMENSION = 512
    try {
      let gifBase64 = await encodeFramesToGif(frames, params.fps)
      let currentFrames = frames
      let downscaled = false

      // If GIF exceeds limit, progressively downscale from original (keep all frames)
      if (gifBase64.length > MAX_GIF_BASE64_BYTES) {
        for (const scale of [0.75, 0.5, 0.35, 0.25]) {
          const scaled = downscaleFrames(frames, scale)
          if (!scaled) break // non-raw frames, can't downscale

          // Check we haven't gone below the minimum dimension
          const probe = Buffer.from(scaled[0], "base64")
          const parsed = tryParseRawRGBA(probe)
          if (parsed && (parsed.width < MIN_DIMENSION && parsed.height < MIN_DIMENSION)) break

          gifBase64 = await encodeFramesToGif(scaled, params.fps)
          currentFrames = scaled
          downscaled = true
          if (gifBase64.length <= MAX_GIF_BASE64_BYTES) break
        }
      }

      // If still too large after maximum downscaling, report error
      if (gifBase64.length > MAX_GIF_BASE64_BYTES) {
        const sizeMB = (gifBase64.length / 1024 / 1024).toFixed(1)
        return {
          title: "Recording too large",
          metadata: { error: `GIF ${sizeMB}MB exceeds 5MB API limit` },
          output: `Recording GIF is ${sizeMB}MB which exceeds the 5MB API image limit. Try recording a shorter duration or lower fps.`,
        }
      }

      const attachment: MessageV2.FilePart = {
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime: "image/gif",
        url: `data:image/gif;base64,${gifBase64}`,
      }

      const sizeNote = downscaled ? " (downscaled to fit API limit)" : ""

      return {
        title: `Recording: ${frames.length} frames`,
        metadata: { frameCount: frames.length, fps: params.fps, duration: params.duration_ms, downscaled },
        output: `Captured ${frames.length} frames at ${params.fps}fps (${(frames.length / params.fps).toFixed(1)}s)${sizeNote}. Analyze the animated GIF to verify game behavior.`,
        attachments: [attachment],
      }
    } catch (err: any) {
      return {
        title: "Recording failed",
        metadata: { error: err.message },
        output: `GIF encoding failed: ${err.message}`,
      }
    }
  },
}, { testOnly: true })
