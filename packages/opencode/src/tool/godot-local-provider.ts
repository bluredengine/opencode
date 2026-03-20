import z from "zod"
import { Tool } from "./tool"

const DESCRIPTION = `Install and start local AI provider dependencies for the Blured Engine.

Use this tool when the user asks to install, set up, or start local providers (RMBG-2.0).

Local providers:
- local_sharp: Image postprocessing -- built-in via Godot (no install needed)
- local_gifenc: GIF recording -- built-in (gifenc inlined, no install needed)
- local_atlas_split: Sprite sheet splitting -- built-in via Godot (no install needed)
- local_rmbg: AI background removal (RMBG-2.0) -- needs Python + pip packages, plus a running sidecar process

Actions:
- "install": Install missing dependencies (and start sidecar for RMBG)
- "start": Start an already-installed provider's sidecar (RMBG only)`

function getBaseUrl(): string {
  return `http://127.0.0.1:${process.env.BLURED_AI_PORT ?? "4096"}`
}

const Params = z.object({
  provider_id: z
    .enum(["local_sharp", "local_gifenc", "local_atlas_split", "local_rmbg", "all"])
    .describe("Which provider to install/start, or 'all' for all providers"),
  action: z
    .enum(["install", "start"])
    .default("install")
    .describe("'install' installs deps (+ starts RMBG sidecar), 'start' only starts an already-installed provider"),
})

export const GodotLocalProviderInstallTool = Tool.define("godot_install_local_provider", {
  description: DESCRIPTION,
  parameters: Params,
  execute: async (params: z.infer<typeof Params>) => {
      const base = getBaseUrl()
      const providerIds =
        params.provider_id === "all"
          ? ["local_sharp", "local_gifenc", "local_atlas_split", "local_rmbg"]
          : [params.provider_id]

      // 1. Check current status
      let status: Record<string, { name: string; service: string; status: string }>
      try {
        const resp = await fetch(`${base}/ai-assets/local-status`, { signal: AbortSignal.timeout(30_000) })
        status = await resp.json()
      } catch (e: any) {
        return {
          title: "Local Provider Status Check Failed",
          output: `Failed to reach AI server at ${base}: ${e?.message ?? e}`,
          metadata: {},
        }
      }

      const results: string[] = []

      for (const id of providerIds) {
        const info = status[id]
        if (!info) {
          results.push(`${id}: Unknown provider`)
          continue
        }

        if (params.action === "start") {
          if (info.status === "ok") {
            results.push(`${info.name}: Already running`)
            continue
          }
          if (info.status === "not_installed") {
            results.push(`${info.name}: Not installed -- use action "install" first`)
            continue
          }
          // installed_not_running
          try {
            const resp = await fetch(`${base}/ai-assets/local-start/${id}`, {
              method: "POST",
              signal: AbortSignal.timeout(120_000),
            })
            const data = await resp.json()
            results.push(`${info.name}: ${data.success ? "Started successfully" : `Failed to start: ${data.detail}`}`)
          } catch (e: any) {
            results.push(`${info.name}: Start request failed: ${e?.message ?? e}`)
          }
          continue
        }

        // action === "install"
        if (info.status === "ok") {
          results.push(`${info.name}: Already installed and running`)
          continue
        }

        if (info.status === "installed_not_running") {
          // RMBG: deps installed but sidecar not running -- start it
          try {
            const resp = await fetch(`${base}/ai-assets/local-start/${id}`, {
              method: "POST",
              signal: AbortSignal.timeout(120_000),
            })
            const data = await resp.json()
            results.push(`${info.name}: Deps already installed. ${data.success ? "Sidecar started." : `Sidecar failed: ${data.detail}`}`)
          } catch (e: any) {
            results.push(`${info.name}: Deps installed but start failed: ${e?.message ?? e}`)
          }
          continue
        }

        // not_installed -- install
        try {
          const resp = await fetch(`${base}/ai-assets/local-install/${id}`, {
            method: "POST",
            signal: AbortSignal.timeout(600_000), // pip install can be slow
          })
          const data = await resp.json()
          results.push(`${info.name}: ${data.success ? "Installed successfully" : `Install failed: ${data.output}`}`)
        } catch (e: any) {
          results.push(`${info.name}: Install request failed: ${e?.message ?? e}`)
        }
      }

      return {
        title: "Local Provider Installation",
        output: results.join("\n"),
        metadata: {},
      }
    },
  },
)
