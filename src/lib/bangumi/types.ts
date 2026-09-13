/** Bangumi 官方 API（api.bgm.tv）类型定义 —— 基于 dist.json 规范（2026-07-24）。 */

export interface BgmUserAvatar {
  large?: string;
  medium?: string;
  small?: string;
}

export interface BgmUser {
  id: number;
  url?: string;
  username?: string;
  nickname: string;
  avatar?: BgmUserAvatar;
  sign?: string;
  /** /v0/me 专属字段：注册时间（ISO 8601 字符串，如 2017-12-03T08:51:16+08:00） */
  reg_time?: string;
  /** /v0/me 专属字段：绑定邮箱（不在界面展示，仅预留） */
  email?: string;
  /** 用户组 id（1=普通用户，仅预留） */
  user_group?: number;
}

/** OAuth token 响应（bgm.tv/oauth/access_token） */
export interface BgmTokenResp {
  access_token: string;
  token_type?: string;
  expires_in: number; // 秒
  refresh_token?: string;
  user_id?: number;
}

/** 本地持久化的登录态（localStorage: aikf:bgm-session） */
export interface BgmSession {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳：access_token 预计过期时刻（提前 5 分钟） */
  expiresAt: number;
  user?: BgmUser;
}

/** 收藏类型：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃 */
export type BgmCollectType = 1 | 2 | 3 | 4 | 5;

export interface BgmSubject {
  id: number;
  name?: string;
  name_cn?: string;
  date?: string;
  images?: { large?: string; common?: string; medium?: string; small?: string; grid?: string };
  eps?: number;
  eps_count?: number;
  summary?: string;
  score?: number;
  rank?: number;
}

/** GET /v0/users/{username}/collections 条目（响应字段运行时兼容：subject 可能内嵌） */
export interface BgmCollectionItem {
  subject_id?: number;
  subject?: BgmSubject & { id?: number };
  type?: BgmCollectType;
  rate?: number;
  ep_status?: number;
  private?: boolean;
  updated_at?: string;
  /** 兜底：某些响应直接平铺条目字段 */
  id?: number;
  name?: string;
  name_cn?: string;
  images?: BgmSubject["images"];
}

/** GET /v0/episodes?subject_id= 条目 */
export interface BgmEpisode {
  id: number;
  type: number;
  name?: string;
  name_cn?: string;
  /** 章节序号（0.5 支持特殊话） */
  ep?: number;
  /** 展示序号（如 "01"、"SP"） */
  order?: string;
  duration?: string;
}

/** POST /v0/search/subjects 请求体 */
export interface BgmSearchBody {
  keyword: string;
  filter?: { type?: number[] };
  limit?: number;
  offset?: number;
}

export interface BgmSearchResult {
  data?: Array<BgmSubject & { date?: string }>;
  total?: number;
  offset?: number;
  limit?: number;
}

/** 通用分页信封（Page）：{ total, limit, offset, data } */
export interface BgmPage<T> {
  total: number;
  limit: number;
  offset: number;
  data?: T[];
}

/** GET /v0/users/-/collections/{subject_id}/episodes 条目（逐集观看状态） */
export interface BgmEpisodeCollectionItem {
  /** 章节完整信息（含 ep / order 序号，用于映射到本地集数） */
  episode: BgmEpisode;
  /** EpisodeCollectionType：0 未收藏 / 1 想看 / 2 看过 / 3 抛弃 */
  type: number;
  /** unix 秒，0 表示未知 */
  updated_at?: number;
}

/** GET /v0/users/{username}/collections/-/characters 条目（收藏的角色） */
export interface BgmUserCharacterCollection {
  id: number;
  name: string;
  /** 角色/机体/舰船/组织... */
  type?: number;
  images?: { large?: string; medium?: string; small?: string; grid?: string } | null;
  created_at?: string;
}

/** GET /v0/users/{username}/collections/-/persons 条目（收藏的人物） */
export interface BgmUserPersonCollection {
  id: number;
  name: string;
  /** 1 个人 / 2 公司 / 3 组合 */
  type?: number;
  career?: string[];
  images?: { large?: string; medium?: string; small?: string; grid?: string } | null;
  created_at?: string;
}
