/** Typed convenience wrappers over the Anich client, with 5-min caching. */
import type {
  BangumiCalendar,
  BangumiCharacterCredit,
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
} from "./types";
import {
  getBangumiCalendar,
  getBangumiCharacters,
  getBangumiDetail,
  getBangumiLatest,
  getBangumiList,
  getBangumiPersons,
  getBangumiRelated,
  getBangumiTags,
  getCommentReplies,
  getEpisodes,
  getPlaybackSources,
  searchBangumi,
  getEpisodeComments,
  getEpisodeCommentCount,
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
};

export type {
  BangumiCalendar,
  BangumiCharacterCredit,
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
};
