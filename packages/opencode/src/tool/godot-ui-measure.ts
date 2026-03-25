import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { Auth } from "../auth"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Identifier } from "../id/id"
import { Log } from "../util/log"

const log = Log.create({ service: "godot-ui-measure" })

// =============================================================================
// Helpers
// =============================================================================

function resolveResPath(resPath: string): string {
  if (resPath.startsWith("res://")) {
    return path.join(Instance.directory, resPath.slice(6))
  }
  return resPath
}

function buildMeasurementPrompt(params: {
  refWidth: number
  refHeight: number
  viewportWidth: number
  viewportHeight: number
  scaleFactor: number
  fontName: string
  panelDescription: string
}): string {
  const { refWidth, refHeight, viewportWidth, viewportHeight, scaleFactor, fontName, panelDescription } = params
  const scaleStr = scaleFactor.toFixed(4)

  return `# UI Reference Image Measurement Task

You are measuring a UI reference image to extract **pixel-precise** layout data for replication
as a Godot .tscn scene file. Be systematic and **exhaustive** — miss nothing.

## CRITICAL: Measure EVERY Visual Element

You MUST measure **every single visual element** visible in the image, no matter how small:
- **Backgrounds**: panel backgrounds, section backgrounds, nested container backgrounds
- **Borders**: outer borders, inner borders, divider lines, separator lines
- **Decorations**: corner ornaments, icons, badges, dots, arrows, shadows, glows
- **Spacing elements**: gaps, margins, padding — measure the actual pixel values
- **Text**: every label, title, subtitle, button text, placeholder text
- **Interactive elements**: buttons, input fields, checkboxes, sliders, toggles
- **Images/Icons**: every icon, thumbnail, avatar, logo — note exact size and position

Do NOT skip any element. Do NOT approximate — measure to the nearest pixel.
If an element is partially transparent or has opacity, note the opacity value.

## Input Parameters

- **Viewport**: ${viewportWidth}×${viewportHeight} (target rendering resolution)
- **Reference image resolution**: ${refWidth}×${refHeight} (measured from the image file)
- **Scale factor**: viewport_height / reference_height = ${viewportHeight} / ${refHeight} = **${scaleStr}×**
- **Font**: ${fontName}
- **Panel type**: ${panelDescription}

## Step 1: Identify Top-Level Layout Structure

Describe the overall layout skeleton:
- What is the root layout direction? (horizontal split? vertical split? overlay?)
- How many top-level regions exist?
- What are their relative proportions?

Describe the layout like:
\`\`\`
[Region A] | [Region B] | [Region C]
   ~X%     |    ~Y%     |    ~Z%
\`\`\`

Output a table:

| Region Name | Layout Role | Approx % of Total |
|---|---|---|

## Step 2: Measure Each Top-Level Region (in reference pixels)

For EACH region, measure:
1. **Bounding box**: x, y, width, height (in reference image pixels)
2. **Background color**: sample the dominant color (hex)
3. **Border**: color, approximate width, corner radius
4. **Padding/margin**: internal spacing from border to content

Format as a table:

| Region | x | y | w | h | bg_color | border_color | border_w | corner_r | padding |
|--------|---|---|---|---|----------|--------------|----------|----------|---------|

## Step 3: Measure Child Elements Within Each Region

For each region, enumerate **ALL** child elements — including backgrounds, borders, separators,
decorative elements, and any visual detail no matter how small. If you can see it, measure it.

For each element measure in REFERENCE pixels (to the nearest pixel):
- Element type (Label, Button, TextureRect/icon, ColorRect/separator, ProgressBar, PanelContainer, HSeparator, etc.)
- Position relative to region (x_offset, y_offset from region top-left)
- Size: width × height (exact pixels, not approximate)
- Content (text string if label/button, color if block, description if icon/image)
- Font size estimate (if text element)
- Text/foreground color (hex, sample the actual pixel color)
- Background color (hex, if applicable — include even subtle backgrounds)
- Border (color, width, style — even 1px borders must be captured)
- Corner radius (exact pixels, if rounded)
- Any special notes (bold, italic, alignment, opacity, gradient, shadow, glow, etc.)

Output per region:

### Region: {name}
| # | Type | x | y | Width | Height | Content | Font Size | FG Color | BG Color | Border | Corner Radius | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Step 4: Measure Spacing Patterns

Extract ALL recurring spacing values in REFERENCE pixels:

| Pattern | Reference px | Where used |
|---------|-------------|------------|

Look for:
- Gap between sibling elements in vertical lists
- Gap between sibling elements in horizontal rows
- Padding inside containers vs margin outside
- Any consistent spacing rhythm (e.g., "8px base unit")

## Step 5: Extract Color Palette

| Color Name/Role | Hex | Usage |
|------|-----|-------|

List ALL distinct colors used in the panel.

## Step 6: Compute Final Scaled Values

Apply scale_factor to EVERY measurement:

\`\`\`
scaled_value = round(reference_value × ${scaleStr})
\`\`\`

Reproduce the Step 2 table with SCALED values:

| Region | x | y | w | h | bg_color | border_w | corner_r | padding |
|--------|---|---|---|---|----------|----------|----------|---------|

Reproduce the Step 3 tables with SCALED values:

### Region: {name} (SCALED for ${viewportWidth}×${viewportHeight})
| # | Type | x | y | Width | Height | Font Size | Corner Radius | Notes |
|---|---|---|---|---|---|---|---|---|

Scale Step 4 spacing values:

| Pattern | Reference (px) | Scaled (px) |
|---|---|---|

## Step 7: Space Budget Verification

Verify the math adds up:

1. Start with viewport dimensions: ${viewportWidth}×${viewportHeight}
2. Subtract outer margins (scaled): top + bottom (and left + right)
3. Subtract outer border (scaled): top + bottom
4. Subtract outer padding (scaled): top + bottom
5. Subtract gaps between top-level regions: (N-1) × gap_scaled
6. = Available content space
7. Sum of all region sizes (scaled) must equal available space
8. If mismatch, adjust the largest region to compensate

Output the budget:

| Item | Value |
|---|---|
| Viewport height | ${viewportHeight} |
| - Outer margin (top + bottom) | ... |
| - Outer border (top + bottom) | ... |
| - Outer padding (top + bottom) | ... |
| - Gaps ((N-1) × gap) | ... |
| = Available content height | ... |
| Sum of region heights | ... |
| Difference (must be 0) | ... |

Do the same for width if there are horizontal regions.

## Final Summary Table

Produce one comprehensive flat list of ALL nodes for the .tscn file:

| Node Path | Type | custom_minimum_size | Position/Offset | Font Size | Colors (FG/BG) | Separation | Corner Radius | Content |
|---|---|---|---|---|---|---|---|---|

Use Godot node paths like "Root/MarginContainer/VBox/Header/TitleLabel".
All values in this table must be SCALED (final viewport pixels).
Map element types to Godot node types:
- Text → Label
- Button → Button
- Image/Icon → TextureRect (placeholder ColorRect)
- Container/Panel → PanelContainer
- Color block → ColorRect
- Progress bar → ProgressBar
- Horizontal group → HBoxContainer
- Vertical group → VBoxContainer
- Spacing/margin → MarginContainer`
}

// =============================================================================
// godot_ui_measure — Vision-based UI layout measurement
// =============================================================================

const DESCRIPTION = `Measure a UI reference/cornerstone image and return precise layout data for building a Godot .tscn scene.

This tool sends the reference image to an LLM with a structured measurement prompt. It returns:
- Top-level layout structure and regions
- Per-element measurements (position, size, colors, fonts)
- Spacing patterns
- Color palette
- All values scaled to the target viewport resolution
- Space budget verification
- A final summary table of all nodes for the .tscn file

Call this INSTEAD of manually measuring sections. Use the returned data to write the .tscn directly.

The vision model is configured via the setup wizard (stored in services.vision_model). Supported providers: anthropic, google, volcengine. If not configured, falls back to the session's default model.`

export const GodotUIMeasureTool = Tool.define("godot_ui_measure", {
  description: DESCRIPTION,
  parameters: z.object({
    reference_image: z
      .string()
      .describe("Path to the cornerstone/reference image (absolute path or res:// path)"),
    viewport_width: z
      .number()
      .int()
      .positive()
      .describe("Target viewport width in pixels (from project.godot display/window/size/viewport_width)"),
    viewport_height: z
      .number()
      .int()
      .positive()
      .describe("Target viewport height in pixels (from project.godot display/window/size/viewport_height)"),
    panel_description: z
      .string()
      .optional()
      .describe("Brief description of the UI panel, e.g. 'shop panel', 'main menu', 'HUD overlay'. Helps the LLM understand context."),
    font_name: z
      .string()
      .optional()
      .describe("Primary font name used in the project, e.g. 'PressStart2P.ttf (pixel font, monospaced)'. Helps estimate font sizes."),
  }),
  async execute(params, ctx) {
    // 1. Resolve image path
    const absImagePath = resolveResPath(params.reference_image)

    // 2. Read image and get dimensions
    let imageBuffer: Buffer
    try {
      imageBuffer = Buffer.from(await fs.readFile(absImagePath))
    } catch (err: any) {
      return {
        title: "Image read failed",
        metadata: { error: err.message },
        output: `Failed to read reference image at ${absImagePath}: ${err.message}`,
      }
    }

    const { GodotImage } = await import("../util/godot-image")
    const meta = await GodotImage.metadata(imageBuffer)
    const refWidth = meta.width
    const refHeight = meta.height
    const scaleFactor = params.viewport_height / refHeight

    ctx.metadata({
      title: `Measuring UI: ${refWidth}×${refHeight} → ${params.viewport_width}×${params.viewport_height} (${scaleFactor.toFixed(2)}×)`,
    })

    // 3. Build measurement prompt
    const measurementPrompt = buildMeasurementPrompt({
      refWidth,
      refHeight,
      viewportWidth: params.viewport_width,
      viewportHeight: params.viewport_height,
      scaleFactor,
      fontName: params.font_name || "default Godot font",
      panelDescription: params.panel_description || "UI panel",
    })

    // 4. Call vision model via session pipeline
    const config = await Config.get()
    const visionModelStr = config.services?.vision_model
    let resultText: string
    let modelUsed: string

    // Parse "providerID/modelID" format
    let resolvedProviderID: string
    let resolvedModelID: string
    let variant: string | undefined

    if (visionModelStr) {
      const providerID = visionModelStr.split("/", 1)[0]
      const modelID = visionModelStr.slice(providerID.length + 1)
      resolvedProviderID = providerID
      resolvedModelID = modelID
      // Set highest thinking variant per provider
      if (providerID === "anthropic") {
        variant = "max" // thinking.budgetTokens: 31999
      } else if (providerID === "google") {
        variant = "high" // thinkingConfig.thinkingLevel: "high"
      }
    } else {
      // No vision model configured — fall back to session default
      const defaultModel = await Provider.defaultModel()
      resolvedProviderID = defaultModel.providerID
      resolvedModelID = defaultModel.modelID
    }

    modelUsed = resolvedModelID

    // Ensure volcengine LLM provider is registered if needed
    if (resolvedProviderID === "volcengine") {
      const existing = await Provider.getProvider("volcengine").catch(() => null)
      if (!existing) {
        let apiKey: string | undefined
        try {
          const authInfo = await Auth.get("volcengine")
          if (authInfo?.type === "api") apiKey = authInfo.key
        } catch {}
        if (!apiKey) apiKey = process.env.VOLCENGINE_API_KEY
        if (!apiKey) {
          return {
            title: "Volcengine API key not configured",
            metadata: { error: "missing api key" },
            output: "Volcengine vision model selected but no API key found. Configure it in the setup wizard or set the VOLCENGINE_API_KEY environment variable.",
          }
        }
        await Config.update({
          provider: {
            volcengine: {
              name: "Volcengine (ByteDance)",
              api: "https://ark.cn-beijing.volces.com/api/v3",
              models: {
                [resolvedModelID]: {
                  modalities: { input: ["text", "image"], output: ["text"] },
                  reasoning: true,
                  attachment: true,
                  tool_call: false,
                  temperature: false,
                  limit: { context: 128000, output: 20000 },
                  cost: { input: 0, output: 0 },
                  release_date: "2025-08-15",
                },
              },
            },
          },
        } as any)
        Config.state.reset()
        Provider.reset()
        log.info("registered volcengine LLM provider at runtime", { model: resolvedModelID })
      }
    }

    try {
      log.info("creating vision measurement session", { provider: resolvedProviderID, model: resolvedModelID, variant })

      const session = await Session.create({
        parentID: ctx.sessionID,
        title: "UI Measurement",
      })

      const base64 = imageBuffer.toString("base64")
      const mimeType = absImagePath.endsWith(".png") ? "image/png" : "image/jpeg"
      const dataUrl = `data:${mimeType};base64,${base64}`

      const messageID = Identifier.ascending("message")
      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          providerID: resolvedProviderID,
          modelID: resolvedModelID,
        },
        variant,
        parts: [
          { type: "text", text: measurementPrompt },
          { type: "file", url: dataUrl, mime: mimeType, filename: path.basename(absImagePath) },
        ],
      })

      const partTypes = result.parts.map((p: any) => p.type)
      log.info("vision measurement parts", { types: partTypes, count: result.parts.length })

      resultText = result.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("")

      // If no text parts, check for reasoning parts (some models return thinking only)
      if (!resultText) {
        const reasoning = result.parts
          .filter((p: any) => p.type === "reasoning")
          .map((p: any) => p.text || p.reasoning || "")
          .join("")
        if (reasoning) {
          log.warn("vision measurement: no text parts, found reasoning parts only", { chars: reasoning.length })
          resultText = reasoning
        }
      }

      log.info("vision measurement returned", { chars: resultText?.length ?? 0 })

      if (!resultText) {
        return {
          title: "Vision model returned empty response",
          metadata: { error: "empty response", partTypes },
          output: `The vision model (${modelUsed}) returned an empty response. Part types in response: [${partTypes.join(", ")}]. This may indicate the model does not support image input or the response format is not recognized. Try a different vision model.`,
        }
      }
    } catch (err: any) {
      log.error("vision measurement error", { error: err.message })
      return {
        title: "Vision model call failed",
        metadata: { error: err.message },
        output: `Failed to call vision model for measurement: ${err.message}\n\nStack: ${err.stack || "none"}`,
      }
    }

    // 5. Return structured output
    const header = [
      `## UI Measurement Results`,
      ``,
      `- **Reference**: ${refWidth}×${refHeight} px`,
      `- **Viewport**: ${params.viewport_width}×${params.viewport_height} px`,
      `- **Scale factor**: ${scaleFactor.toFixed(4)}×`,
      `- **Model used**: ${modelUsed}`,
      ``,
      `**IMPORTANT: These measurements are pixel-precise. Use them directly to write the .tscn — do NOT re-examine or re-measure the reference image yourself.**`,
      ``,
      `---`,
      ``,
    ].join("\n")

    return {
      title: `UI Measurement: ${refWidth}×${refHeight} → ${params.viewport_width}×${params.viewport_height}`,
      metadata: {
        reference_width: refWidth,
        reference_height: refHeight,
        viewport_width: params.viewport_width,
        viewport_height: params.viewport_height,
        scale_factor: scaleFactor,
        truncated: false,
      },
      output: header + resultText,
    }
  },
})
