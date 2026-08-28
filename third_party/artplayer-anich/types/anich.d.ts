// Anich Edition — TypeScript declarations for the `Artplayer.anich`
// namespace. These types describe the JS port of the Anich Go SDK
// bundled into the customized ArtPlayer build.

export interface WireField {
  num: number
  wire: 0 | 1 | 2 | 5
  varint: number | null
  fixed64: number | null
  fixed32: number | null
  bytes: Uint8Array | null
  next: number
}

export interface PlaybackSource {
  rawURL: string
  url: string
  sort: number
  type: string
  caption: string
}

export interface VOD {
  sources: PlaybackSource[]
}

export interface DanmakuItem {
  id: string
  color: string
  date: number
  text: string
  t: string
  time: number
  type: number
  from: string
}

export interface DanmakuPage {
  items: DanmakuItem[]
  skip: number
}

export interface BilibiliDanmakuItem {
  id: number
  progress: number
  mode: number
  fontSize: number
  color: number
  midHash: string
  content: string
  ctime: number
  weight: number
  action: string
  pool: number
  idStr: string
}

export interface BilibiliDanmakuSegment {
  items: BilibiliDanmakuItem[]
}

export interface BangumiListItem {
  id: number
  title: string
  episode: number
  episodesTotal: number
  status: string
  date: number
  image: string
  tagline: string
}

export interface BangumiList {
  items: BangumiListItem[]
  prev: number
  next: number
}

export interface CommentContent {
  type: string
  content: string
}

export interface CommentUser {
  name: string
  exp: number
  avatar: string
  color: string
  issp: boolean
}

export interface Comment {
  id: string
  source: string
  created: string
  updated: string
  date: number
  text: string
  contents: CommentContent[]
  user: CommentUser | null
  address: string
  like: boolean
  likesCount: number
  repliesCount: number
  replies: Comment[]
}

export interface CommentList {
  error: boolean
  message: string
  data: Comment[]
}

export interface AnichClientConfig {
  baseUrl: string
  bilibiliDmUrl: string
  qqVideoUrl: string
  dandanUrl: string
  userAgent: string
  token: string
}

export interface AnichClient {
  getRuntimeConfig(): Promise<any>
  getPlaybackSources(bangumiID: number, episode: number): Promise<Uint8Array>
  getDanmakuPage(bangumiID: number, episode: number, skip: number): Promise<Uint8Array>
  getAllDanmaku(bangumiID: number, episode: number, pageSize?: number): Promise<DanmakuItem[]>
  getBilibiliDanmakuSegment(typ: number, oid: number, segmentIndex: number): Promise<Uint8Array>
  getEpisodeComments(bangumiID: number, episode: string): Promise<any>
  getEpisodeCommentCount(bangumiID: number, episode: string): Promise<any>
  getCommentReplies(commentID: string, skip?: string): Promise<any>
  config: AnichClientConfig
}

export interface AnichClientOptions {
  baseUrl?: string
  bilibiliDmUrl?: string
  qqVideoUrl?: string
  dandanUrl?: string
  userAgent?: string
  token?: string
  fetchImpl?: typeof fetch
}

export interface AnichNamespace {
  // wire.js
  WIRE: { VARINT: 0; FIXED64: 1; BYTES: 2; FIXED32: 5 }
  readVarint(data: Uint8Array, offset?: number): { value: number; next: number }
  normalizeWireData(data: Uint8Array): Uint8Array
  nextField(data: Uint8Array, offset?: number): WireField | null
  iterateFields(data: Uint8Array): Generator<WireField>
  fieldString(field: WireField | null): string | null
  fieldDouble(field: WireField | null): number | null
  fieldVarintNum(field: WireField | null): number | null
  fieldVarintBool(field: WireField | null): boolean | null

  // parsers.js
  parsePlaybackSource(data: Uint8Array): PlaybackSource
  parseVOD(data: Uint8Array): VOD
  parseDanmakuItem(data: Uint8Array): DanmakuItem
  parseDanmakuPage(data: Uint8Array): DanmakuPage
  parseBilibiliDanmakuItem(data: Uint8Array): BilibiliDanmakuItem
  parseBilibiliDanmakuSegment(data: Uint8Array): BilibiliDanmakuSegment
  parseBangumiListItem(data: Uint8Array): BangumiListItem
  parseBangumiList(data: Uint8Array): BangumiList
  parseComment(raw: any): Comment
  parseCommentList(raw: any): CommentList
  decodePlaybackURL(raw: string): string
  decodeBase64Flex(s: string): string

  // client.js
  DEFAULT_BASE_URL: string
  DEFAULT_BILIBILI_DM_URL: string
  DEFAULT_QQ_VIDEO_URL: string
  DEFAULT_DANDAN_URL: string
  DANDAN_OFFICIAL_URL: string
  DEFAULT_USER_AGENT: string
  DEFAULT_DANMAKU_PAGE_SIZE: number
  createAnichClient(opts?: AnichClientOptions): AnichClient
  buildUrl(baseURL: string, path: string, query?: Record<string, string | number>): string
}
