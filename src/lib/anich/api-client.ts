/** Typed convenience wrappers over the Anich client, with 5-min caching. */
import type {
  BangumiCalendar,
  BangumiCharacterCredit,
  BangumiCharacterDetail,
  BangumiDetail,
  BangumiList,
  BangumiListOptions,
  BangumiLatest,
  BangumiPersonCredit,
  BangumiPersonDetail,
  BangumiWorksPage,
  BangumiWork,
  BangumiTag,
  Episode,
  BangumiRelatedItem,
  VOD,
  CommentList,
  CommentCount,
  DanmakuItem,
} from "./types";
import {
  getBangumiCalendar,
  getBangumiCharacters,
  getBangumiCharacter,
  getBangumiCharacterWorks,
  getBangumiDetail,
  getBangumiLatest,
  getBangumiList,
  getBangumiPersons,
  getBangumiPerson,
  getBangumiPersonWorks,
  getBangumiRelated,
  getBangumiTags,
  getAutocomplete,
  getCommentReplies,
  getEpisodes,
  getNotice,
  getPlaybackSources,
  getRecommend,
  getSearchTrends,
  searchBangumi,
  getEpisodeComments,
  getEpisodeCommentCount,
  getAllDanmaku,
} from "./client";
import { withCache } from "./cache";

// Stable cache keys (skip is part of the key when relevant).
const k = (...parts: (string | number | undefined)[]) => parts.join("|");

export const anich = {
  latest: () => withCache("latest", () => getBangumiLatest()),
  calendar: () => withCache("calendar", () => getBangumiCalendar()),
  tags: (type: "genre" | "mark" = "genre", skip = 0) =>
    withCache(k("tags", type, skip), () => getBangumiTags(type, skip)),
  list: (opts: BangumiListOptions = {}) =>
    withCache(
      k("list", opts.skip, opts.type, opts.lang, opts.year, opts.genre, opts.mark),
      () => getBangumiList(opts)
    ),
  search: (keyword: string, skip = 0) =>
    withCache(k("search", keyword, skip), () => searchBangumi(keyword, skip)),
  detail: (id: number) => withCache(k("detail", id), () => getBangumiDetail(id)),
  episodes: (id: number) => withCache(k("episodes", id), () => getEpisodes(id)),
  related: (id: number) => withCache(k("related", id), () => getBangumiRelated(id)),
  characters: (id: number) => withCache(k("characters", id), () => getBangumiCharacters(id)),
  persons: (id: number) => withCache(k("persons", id), () => getBangumiPersons(id)),
  // ── 角色/制作人员详情与关联作品（需求：角色/制作/关联条目可点击查看详情）──
  characterDetail: (id: number) =>
    withCache(k("charDetail", id), () => getBangumiCharacter(id)),
  personDetail: (id: number) =>
    withCache(k("personDetail", id), () => getBangumiPerson(id)),
  characterWorks: (id: number, skip = 0) =>
    withCache(k("charWorks", id, skip), () => getBangumiCharacterWorks(id, skip)),
  personWorks: (id: number, skip = 0) =>
    withCache(k("personWorks", id, skip), () => getBangumiPersonWorks(id, skip)),
  vod: (id: number, episode: number) =>
    // VOD sources are NOT cached — playback URLs rotate and expire.
    getPlaybackSources(id, episode),
  comments: (bangumiID: number, episode: number, skip?: string) =>
    withCache(k("comments", bangumiID, episode, skip), () =>
      getEpisodeComments(bangumiID, episode, skip)
    ),
  commentCount: (bangumiID: number, episode: number) =>
    withCache(k("commentCount", bangumiID, episode), () =>
      getEpisodeCommentCount(bangumiID, episode)
    ),
  commentReplies: (commentID: string, skip?: string) =>
    getCommentReplies(commentID, skip),
  // Danmaku — NOT cached (live data, may change between episodes/refreshes)
  danmaku: (bangumiID: number, episode: number) =>
    getAllDanmaku(bangumiID, episode),
  // ── 无鉴权新接口（1.5.24）──
  recommend: () => withCache("recommend", () => getRecommend()),
  autocomplete: (keyword: string) =>
    withCache(k("ac", keyword), () => getAutocomplete(keyword)),
  searchTrends: () => withCache("trends", () => getSearchTrends()),
  notice: () => getNotice(),
};

export type {
  BangumiCalendar,
  BangumiCharacterCredit,
  BangumiCharacterDetail,
  BangumiPersonDetail,
  BangumiWorksPage,
  BangumiWork,
  BangumiDetail,
  BangumiList,
  BangumiListOptions,
  BangumiLatest,
  BangumiPersonCredit,
  BangumiTag,
  Episode,
  BangumiRelatedItem,
  VOD,
  CommentList,
  CommentCount,
  DanmakuItem,
};
