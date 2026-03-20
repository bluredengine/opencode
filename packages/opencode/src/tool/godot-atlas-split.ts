import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { AtlasSplitter } from "../provider/asset/atlas-splitter"
import { GodotAtlasSplit } from "../util/godot-image"
import { Identifier } from "../id/id"
import type { MessageV2 } from "../session/message-v2"

function resolveResPath(resPath: string): string {
  if (resPath.startsWith("res://")) {
    return path.join(Instance.directory, resPath.slice(6))
  }
  return resPath
}

function toResPath(absPath: string): string {
  const rel = path.relative(Instance.directory, absPath).replace(/\\/g, "/")
  return `res://${rel}`
}

const DESCRIPTION = `Detect and split UI elements from an atlas image using connected-component analysis.

Use this AFTER generating a UI element sheet via godot_asset_pipeline. The tool auto-detects each element's bounding box and outputs AtlasTexture .tres files that reference regions in the original atlas image.

Returns detected element count, labels, dimensions, and file paths.`

export const GodotAtlasSplitTool = Tool.define(
  "godot_atlas_split",
  {
    description: DESCRIPTION,
    parameters: z.object({
      atlas_path: z.string().describe("res:// path to the atlas image containing multiple UI elements"),
      output_dir: z
        .string()
        .describe("res:// directory to save split assets, e.g. 'res://assets/ui/main_menu/'"),
      element_labels: z
        .array(z.string())
        .optional()
        .describe(
          "Names for each detected element in order (e.g. ['play_button', 'settings_icon']). Unlabeled elements use 'element_N'",
        ),
      min_area: z
        .number()
        .int()
        .min(1)
        .default(100)
        .describe("Minimum pixel area to consider a valid element (filters noise)"),
      dilation_kernel: z
        .number()
        .int()
        .min(1)
        .max(21)
        .default(5)
        .describe("Morphological dilation kernel size (merges nearby pixels into one element)"),
      dilation_iterations: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(2)
        .describe("Number of dilation iterations (more = more aggressive merging)"),
      padding: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(2)
        .describe("Extra padding in pixels around each detected element"),
      bg_mode: z
        .enum(["alpha", "white", "black"])
        .default("alpha")
        .describe("How to detect background: alpha (transparent), white, or black"),
    }),
    async execute(params, ctx) {
      const absAtlasPath = resolveResPath(params.atlas_path)
      const absOutputDir = resolveResPath(params.output_dir)

      // Verify atlas file exists
      try {
        await fs.access(absAtlasPath)
      } catch {
        return {
          title: "Atlas split failed",
          metadata: { error: "file_not_found" } as Record<string, any>,
          output: `Error: Atlas image not found: ${params.atlas_path}`,
        }
      }

      // Ensure output directory exists
      await fs.mkdir(absOutputDir, { recursive: true })

      // Detect and split elements via Godot's connected-component labeling
      const regions = await GodotAtlasSplit.split(
        { path: absAtlasPath },
        {
          minArea: params.min_area,
          dilationKernel: params.dilation_kernel,
          dilationIterations: params.dilation_iterations,
          padding: params.padding,
          bgMode: params.bg_mode,
        },
      )

      if (regions.length === 0) {
        return {
          title: "No elements detected",
          metadata: { elementCount: 0 },
          output: `No elements detected in ${params.atlas_path}. Try adjusting min_area (current: ${params.min_area}) or bg_mode (current: ${params.bg_mode}).`,
        }
      }

      // Assign labels
      const labeledRegions = regions.map((r, i) => ({
        ...r,
        label: params.element_labels?.[i] ?? `element_${i}`,
        buffer: Buffer.from(r.data, "base64"),
      }))

      const outputFiles: string[] = []
      const atlasResPath = params.atlas_path

      // Write AtlasTexture .tres files
      for (const region of labeledRegions) {
        const filename = `${region.label}.tres`
        const outputPath = path.join(absOutputDir, filename)
        const tresContent = AtlasSplitter.generateAtlasTres(atlasResPath, region)
        await fs.writeFile(outputPath, tresContent, "utf-8")
        outputFiles.push(toResPath(outputPath))
      }

      // Build output summary (no debug image — SVG composite was non-critical and required sharp)
      const elementList = labeledRegions
        .map((r) => `  ${r.label}: ${r.rect.width}x${r.rect.height} at (${r.rect.x}, ${r.rect.y})`)
        .join("\n")

      const output = [
        `Detected ${regions.length} elements in ${params.atlas_path}:`,
        elementList,
        "",
        `AtlasTexture files written to ${params.output_dir}:`,
        ...outputFiles.map((f) => `  ${f}`),
      ].join("\n")

      return {
        title: `Split ${regions.length} elements`,
        metadata: {
          elementCount: regions.length,
          elements: labeledRegions.map((r) => ({
            label: r.label,
            rect: r.rect,
          })),
          outputFiles,
        },
        output,
      }
    },
  },
  {},
)
