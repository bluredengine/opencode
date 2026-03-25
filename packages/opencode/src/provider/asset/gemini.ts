import { Log } from "../../util/log"
import { AssetProvider } from "./asset-provider"

/**
 * Google Gemini image generation provider.
 *
 * Uses the Gemini generateContent API with responseModalities: ["IMAGE"]
 * to generate images via nano-banana-2 (Flash) and nano-banana-pro (Pro) models.
 */
export class GeminiProvider implements AssetProvider.Provider {
  readonly id = "google"
  readonly name = "Google Gemini"
  readonly supportedTypes: AssetProvider.AssetType[] = [
    "texture",
    "sprite",
    "cubemap",
    "material",
  ]

  private apiKey: string
  private apiUrl: string
  private log = Log.create({ service: "asset.gemini" })

  /** In-memory cache of completed generation outputs */
  private resultCache = new Map<
    string,
    { status: AssetProvider.GenerationStatus["status"]; images?: Buffer[]; message?: string }
  >()

  /** In-memory cache of downloaded asset bundles */
  private bundleCache = new Map<string, AssetProvider.AssetBundle>()

  /** Model ID → Gemini API model name mapping */
  private static readonly MODELS: Record<string, {
    apiModel: string
    description: string
    cost: number
  }> = {
    "nano-banana-2": {
      apiModel: "gemini-2.0-flash-exp-image-generation",
      description: "Nano Banana 2 (Gemini Flash Image) -- fast, pro-level quality",
      cost: 0.067,
    },
    "nano-banana-pro": {
      apiModel: "gemini-2.0-flash-exp-image-generation",
      description: "Nano Banana Pro (Gemini Pro Image) -- highest quality, slower",
      cost: 0.10,
    },
  }

  /** Supported aspect ratios */
  private static readonly ASPECT_RATIOS: [string, number][] = [
    ["1:1", 1], ["16:9", 16 / 9], ["9:16", 9 / 16], ["3:2", 3 / 2], ["2:3", 2 / 3],
    ["4:3", 4 / 3], ["3:4", 3 / 4], ["4:5", 4 / 5], ["5:4", 5 / 4], ["21:9", 21 / 9],
  ]

  constructor(config: { apiKey: string; apiUrl?: string }) {
    this.apiKey = config.apiKey
    this.apiUrl = config.apiUrl ?? "https://generativelanguage.googleapis.com/v1beta"
  }

  async listModels(): Promise<AssetProvider.ModelInfo[]> {
    return Object.entries(GeminiProvider.MODELS).map(([id, model]) => ({
      id,
      name: id,
      description: model.description,
      supportedTypes: ["texture", "sprite", "cubemap", "material"] as AssetProvider.AssetType[],
      pricing: { unit: "per image", cost: model.cost },
      parameters: [
        {
          name: "aspect_ratio",
          type: "enum" as const,
          description: "Image aspect ratio",
          default: "1:1",
          options: GeminiProvider.ASPECT_RATIOS.map(([label]) => label),
        },
      ],
    }))
  }

  async generate(request: AssetProvider.GenerationRequest): Promise<AssetProvider.GenerationResult> {
    const modelId = request.model ?? "nano-banana-2"
    const modelEntry = GeminiProvider.MODELS[modelId]

    if (!modelEntry) {
      throw new Error(`Unknown Gemini model: ${modelId}. Available: ${Object.keys(GeminiProvider.MODELS).join(", ")}`)
    }

    const generationId = `gem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.resultCache.set(generationId, { status: "processing" })

    // Run async so we can return immediately
    this.runGeneration(generationId, modelEntry.apiModel, request)

    return {
      generationId,
      status: "processing",
    }
  }

  private async runGeneration(
    generationId: string,
    apiModel: string,
    request: AssetProvider.GenerationRequest,
  ): Promise<void> {
    try {
      // Build aspect ratio
      let aspectRatio = "1:1"
      if (typeof request.parameters.aspect_ratio === "string" && request.parameters.aspect_ratio) {
        aspectRatio = request.parameters.aspect_ratio
      } else if (request.parameters.width && request.parameters.height) {
        aspectRatio = GeminiProvider.findClosestAspectRatio(
          request.parameters.width as number,
          request.parameters.height as number,
        )
      } else if (request.parameters.size) {
        const match = String(request.parameters.size).match(/^(\d+)x(\d+)$/)
        if (match) {
          aspectRatio = GeminiProvider.findClosestAspectRatio(parseInt(match[1]), parseInt(match[2]))
        }
      }

      let prompt = request.prompt
      if (request.negativePrompt) {
        prompt = `${prompt}. Avoid: ${request.negativePrompt}`
      }

      const url = `${this.apiUrl}/models/${apiModel}:generateContent?key=${this.apiKey}`

      const body = {
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio,
            outputMimeType: "image/png",
          },
        },
      }

      this.log.info("generating image via gemini", { model: apiModel, prompt: request.prompt, aspectRatio })

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Gemini API error ${response.status}: ${errorText}`)
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string
              inlineData?: { mimeType: string; data: string }
              inline_data?: { mime_type: string; data: string }
            }>
          }
        }>
      }

      // Extract base64 images from response
      const images: Buffer[] = []
      for (const candidate of data.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const inlineData = part.inlineData ?? part.inline_data
          if (inlineData?.data) {
            const mime = inlineData.mimeType ?? (inlineData as any).mime_type ?? ""
            if (mime && mime !== "image/png") {
              this.log.error("Gemini returned non-PNG image despite outputMimeType=image/png", { mimeType: mime })
            }
            images.push(Buffer.from(inlineData.data, "base64"))
          }
        }
      }

      if (images.length === 0) {
        throw new Error("Gemini returned no images in response")
      }

      this.resultCache.set(generationId, { status: "completed", images })
      this.log.info("gemini generation completed", { id: generationId, imageCount: images.length })
    } catch (error: any) {
      this.log.error("gemini generation failed", { id: generationId, error: error.message })
      this.resultCache.set(generationId, { status: "failed", message: error.message })
    }
  }

  async checkStatus(generationId: string): Promise<AssetProvider.GenerationStatus> {
    const cached = this.resultCache.get(generationId)
    if (!cached) {
      return {
        generationId,
        status: "failed",
        message: "Generation not found",
      }
    }

    return {
      generationId,
      status: cached.status,
      progress: cached.status === "completed" ? 100 : cached.status === "processing" ? 50 : 0,
      ...(cached.message ? { message: cached.message } : {}),
    }
  }

  async download(generationId: string): Promise<AssetProvider.AssetBundle> {
    const cachedBundle = this.bundleCache.get(generationId)
    if (cachedBundle) {
      return cachedBundle
    }

    const cached = this.resultCache.get(generationId)
    if (!cached || !cached.images?.length) {
      throw new Error(`No output available for generation ${generationId}`)
    }

    const assets: AssetProvider.BundleAsset[] = cached.images.map((data, i) => ({
      type: "texture" as const,
      role: (i === 0 ? "primary" : "texture") as "primary" | "texture",
      data,
      filename: `image_${i}${GeminiProvider.detectImageExtension(data)}`,
      metadata: { index: i },
    }))

    const bundle: AssetProvider.AssetBundle = {
      bundleId: generationId,
      assets,
    }
    this.bundleCache.set(generationId, bundle)
    return bundle
  }

  supportsTransform(_transform: AssetProvider.TransformType): boolean {
    return false
  }

  async transform(_request: AssetProvider.TransformRequest): Promise<AssetProvider.GenerationResult> {
    throw new Error("Gemini provider does not support transforms yet")
  }

  private static findClosestAspectRatio(w: number, h: number): string {
    const target = w / h
    let best = GeminiProvider.ASPECT_RATIOS[0][0]
    let bestDiff = Math.abs(target - GeminiProvider.ASPECT_RATIOS[0][1])
    for (const [label, ratio] of GeminiProvider.ASPECT_RATIOS) {
      const diff = Math.abs(target - ratio)
      if (diff < bestDiff) {
        best = label
        bestDiff = diff
      }
    }
    return best
  }

  private static detectImageExtension(data: Buffer): string {
    if (data.length < 4) return ".png"
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ".png"
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg"
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data.length >= 12 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return ".webp"
    return ".png"
  }
}
