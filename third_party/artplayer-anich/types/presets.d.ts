// Anich Edition — TypeScript declarations for `Artplayer.presets`.
import type { Option } from './option'

export interface DanmukuItem {
  text: string
  time: number
  mode: 'scroll' | 'top' | 'bottom'
  color: string
  border: boolean
}

export interface AnichPresetParams {
  container: HTMLElement
  url?: string
  type?: string
  m3u8Loader?: (
    video: HTMLVideoElement,
    src: string,
    art: any,
  ) =>
    | void
    | (() => void)
    | { destroy(): void }
    | { hls: { destroy(): void } }
  danmakuItems?: DanmukuItem[]
  customControls?: any[]
  customSettings?: any[]
  anichTheme?: boolean
  autoplay?: boolean
  volume?: number
  lang?: string
  plugins?: Array<(art: any) => unknown>
}

export interface PresetsNamespace {
  /**
   * Build an Anich-flavored ArtPlayer option preset.
   * Usage: `new Artplayer(Artplayer.presets.anich({ container, url, ... }))`
   */
  anich(params: AnichPresetParams): Partial<Option>
  ANICH_ICONS: Record<string, string>
  toDanmukuItems(items: any[]): DanmukuItem[]
}
