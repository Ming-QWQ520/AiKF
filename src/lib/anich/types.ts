/** Typed models for the Anich API, mirroring anichsdk Go structs. */

export type BangumiType = "tv" | "movie" | "ova";
export type BangumiLang = "ja" | "zh" | "en" | "ko" | "other";
export type BangumiTagType = "genre" | "mark";

export interface BangumiListOptions {
  skip?: number;
  type?: BangumiType;
  lang?: BangumiLang;
  year?: string;
  genre?: string;
  mark?: string;
}

export interface BangumiListItem {
  id: number;
  title: string;
  episode: number;
  episodesTotal: number;
  status: string;
  date: number;
  image: string;
  tagline: string;
}

export interface BangumiList {
  items: BangumiListItem[];
  prev: number;
  next: number;
}

export interface BangumiLatestItem {
  status: boolean;
  id: number;
  episode: number;
  airdate: number;
  duration: number;
  image: string;
  title: string;
  name: string;
}

export interface BangumiLatest {
  items: BangumiLatestItem[];
}

export interface BangumiTag {
  name: string;
  count: number;
  image: string;
}

export interface BangumiMark {
  name: string;
  count: number;
}

export interface BangumiRating {
  site: string;
  score: number;
  count?: number;
}

export interface BangumiDetail {
  id: number;
  airdate: number;
  title: string;
  titles: string[];
  image: string;
  lang: string;
  region: string[];
  genres: string[];
  marks: BangumiMark[];
  rating: BangumiRating[];
  overview: string;
  episode: number;
  episodesTotal: number;
  status: string;
}

export interface BangumiCalendarEpisode {
  sort: number;
  date: number;
  name: string;
  future: boolean;
}

export interface BangumiCalendarItem {
  id: number;
  title: string;
  image: string;
  lang: string;
  region: string[];
  genres: string[];
  episodes: BangumiCalendarEpisode[];
}

export interface BangumiCalendarDay {
  sort: number;
  list: BangumiCalendarItem[];
}

export interface BangumiCalendar {
  data: BangumiCalendarDay[];
}

export interface EpisodeSite {
  site: string;
  id: string;
}

export interface EpisodeRating {
  site: string;
  score: number;
  count: number;
}

export interface Episode {
  status: boolean;
  sort: number;
  airdate: number;
  duration: number;
  sites: EpisodeSite[];
  rating: EpisodeRating[];
  image: string;
  title: string;
  overview: string;
}

export interface BangumiRelatedItem {
  id: number;
  title: string;
  name: string;
  episode: number;
  episodesTotal: number;
  status: string;
  date: number;
  image: string;
  tagline: string;
  type: string;
}

export interface BangumiCharacterActor {
  id: number;
  name: string;
  image: string;
}

export interface BangumiCharacterCredit {
  id: number;
  role: string;
  name: string;
  image: string;
  actors: BangumiCharacterActor[];
}

export interface BangumiPersonCredit {
  id: number;
  name: string;
  image: string;
  jobs: string;
}

export interface BangumiCharacterDetailActor {
  id: number;
  name: string;
  image: string;
}

export interface BangumiCharacterDetail {
  id: number;
  name: string;
  aka: string[];
  gender: string;
  summary: string;
  image: string;
  actors: BangumiCharacterDetailActor[];
}

export interface BangumiPersonDetail {
  id: number;
  name: string;
  aka: string[];
  gender: string;
  summary: string;
  image: string;
}

export interface BangumiWork {
  id: number;
  title: string;
  episode: number;
  episodesTotal: number;
  status: string;
  date: number;
  image: string;
  tagline: string;
}

export interface BangumiWorksPage {
  data: BangumiWork[];
  next: boolean;
}

export interface PlaybackSource {
  rawURL: string;
  url: string;
  sort: number;
  type: string;
  caption: string;
}

export interface VOD {
  sources: PlaybackSource[];
}

export interface CommentContent {
  type: string;
  content: string;
}

export interface CommentUser {
  name: string;
  exp: number;
  avatar: string;
  color: string;
  issp: boolean;
}

export interface Comment {
  id: string;
  source: string;
  created: string;
  updated: string;
  date: number;
  text: string;
  contents: CommentContent[];
  user: CommentUser;
  address: string;
  like: boolean;
  likes_count: number;
  replies_count: number;
  replies: Comment[];
}

export interface CommentList {
  error: boolean;
  message: string;
  body: { data: Comment[] };
}

export interface CommentCount {
  error: boolean;
  message: string;
  body: { data: number };
}

/* ── Danmaku (弹幕) ── */

/** A single danmaku item, parsed from the Anich /danmaku protobuf response. */
export interface DanmakuItem {
  id: string;
  color: string;   // hex color string, e.g. "#ffffff"
  date: number;    // timestamp (seconds)
  text: string;    // danmaku content
  t: string;       // source type tag
  time: number;    // position in video (seconds)
  type: number;    // 0=scroll, 1=top, 2=bottom
  from: string;    // source identifier
}

/** A page of danmaku items (paginated by DefaultDanmakuPageSize = 3000). */
export interface DanmakuPage {
  items: DanmakuItem[];
  skip: number;
}

/** Request body for posting a new danmaku. */
export interface PostDanmakuRequest {
  bangumiID: number;
  episode: number;
  type: number;     // 0=scroll, 1=top, 2=bottom
  time: number;     // position in video (seconds)
  text: string;
  color: string;    // hex color
  token?: string;   // user auth token (optional)
}
