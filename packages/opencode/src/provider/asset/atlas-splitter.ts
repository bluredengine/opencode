export namespace AtlasSplitter {
  /** A single detected UI element region within an atlas image */
  export interface DetectedRegion {
    /** Sequential index (0-based), sorted top-left to bottom-right */
    index: number
    /** Bounding rectangle in the atlas image */
    rect: { x: number; y: number; width: number; height: number }
    /** Pixel area of the detected contour */
    area: number
    /** Cropped image buffer (PNG) */
    buffer: Buffer
    /** Optional label assigned by the caller */
    label?: string
  }

  /**
   * Generate Godot AtlasTexture .tres file content for a detected region.
   */
  export function generateAtlasTres(atlasResPath: string, region: DetectedRegion): string {
    const { x, y, width, height } = region.rect
    return `[gd_resource type="AtlasTexture" load_steps=2 format=3]

[ext_resource type="Texture2D" path="${atlasResPath}" id="1"]

[resource]
atlas = ExtResource("1")
region = Rect2(${x}, ${y}, ${width}, ${height})
margin = Rect2(0, 0, 0, 0)
`
  }
}
