/** Protobuf message parsers → typed models. Ported from anichsdk Go files. */

import {
  fieldDouble,
  fieldString,
  fieldVarintBool,
  fieldVarintNum,
  iterateFields,
  normalizeWireData,
  type WireField,
} from "./wire";
import type {
  BangumiCharacterActor,
  BangumiCharacterCredit,
  BangumiLatestItem,
  BangumiListItem,
  BangumiPersonCredit,
  BangumiRelatedItem,
  Episode,
  EpisodeRating,
  EpisodeSite,
  PlaybackSource,
} from "./types";

function parseItem<T>(
  data: Uint8Array,
  handler: (field: WireField, acc: T) => void,
  init: T
): T {
  const acc = init;
  for (const f of iterateFields(data)) handler(f, acc);
  return acc;
}

/* ---------- BangumiListItem ---------- */
export function parseBangumiListItem(data: Uint8Array): BangumiListItem {
  return parseItem(data, (f, item: BangumiListItem) => {
    switch (f.num) {
      case 1: { const v = fieldVarintNum(f); if (v != null) item.id = v; break; }
      case 2: { const v = fieldString(f); if (v != null) item.title = v; break; }
      case 3: { const v = fieldVarintNum(f); if (v != null) item.episode = v; break; }
      case 4: { const v = fieldVarintNum(f); if (v != null) item.episodesTotal = v; break; }
      case 5: { const v = fieldString(f); if (v != null) item.status = v; break; }
      case 6: { const v = fieldDouble(f); if (v != null) item.date = v; break; }
      case 7: { const v = fieldString(f); if (v != null) item.image = v; break; }
      case 8: { const v = fieldString(f); if (v != null) item.tagline = v; break; }
    }
  }, { id: 0, title: "", episode: 0, episodesTotal: 0, status: "", date: 0, image: "", tagline: "" });
}

export function parseBangumiList(data: Uint8Array) {
  const normalized = normalizeWireData(data);
  const items: BangumiListItem[] = [];
  let prev = 0;
  let next = 0;
  for (const f of iterateFields(normalized)) {
    switch (f.num) {
      case 1:
        if (f.wire === 2) items.push(parseBangumiListItem(f.bytes));
        break;
      case 2: { const v = fieldVarintNum(f); if (v != null) prev = v; break; }
      case 3: { const v = fieldVarintNum(f); if (v != null) next = v; break; }
    }
  }
  return { items, prev, next };
}

/* ---------- BangumiLatestItem ---------- */
export function parseBangumiLatestItem(data: Uint8Array): BangumiLatestItem {
  return parseItem(data, (f, item: BangumiLatestItem) => {
    switch (f.num) {
      case 1: { const v = fieldVarintBool(f); if (v != null) item.status = v; break; }
      case 2: { const v = fieldVarintNum(f); if (v != null) item.id = v; break; }
      case 3: { const v = fieldVarintNum(f); if (v != null) item.episode = v; break; }
      case 4: { const v = fieldDouble(f); if (v != null) item.airdate = v; break; }
      case 5: { const v = fieldVarintNum(f); if (v != null) item.duration = v; break; }
      case 6: { const v = fieldString(f); if (v != null) item.image = v; break; }
      case 7: { const v = fieldString(f); if (v != null) item.title = v; break; }
      case 8: { const v = fieldString(f); if (v != null) item.name = v; break; }
    }
  }, { status: false, id: 0, episode: 0, airdate: 0, duration: 0, image: "", title: "", name: "" });
}

export function parseBangumiLatest(data: Uint8Array) {
  const normalized = normalizeWireData(data);
  const items: BangumiLatestItem[] = [];
  for (const f of iterateFields(normalized)) {
    if (f.num === 1 && f.wire === 2) items.push(parseBangumiLatestItem(f.bytes));
  }
  return { items };
}

/* ---------- Episodes ---------- */
function parseEpisodeSite(data: Uint8Array): EpisodeSite {
  return parseItem(data, (f, item: EpisodeSite) => {
    switch (f.num) {
      case 1: { const v = fieldString(f); if (v != null) item.site = v; break; }
      case 2: { const v = fieldString(f); if (v != null) item.id = v; break; }
    }
  }, { site: "", id: "" });
}

function parseEpisodeRating(data: Uint8Array): EpisodeRating {
  return parseItem(data, (f, item: EpisodeRating) => {
    switch (f.num) {
      case 1: { const v = fieldString(f); if (v != null) item.site = v; break; }
      case 2: { const v = fieldVarintNum(f); if (v != null) item.score = v; break; }
      case 3: { const v = fieldVarintNum(f); if (v != null) item.count = v; break; }
    }
  }, { site: "", score: 0, count: 0 });
}

function parseEpisode(data: Uint8Array): Episode {
  return parseItem(data, (f, item: Episode) => {
    switch (f.num) {
      case 1: { const v = fieldVarintBool(f); if (v != null) item.status = v; break; }
      case 2: { const v = fieldVarintNum(f); if (v != null) item.sort = v; break; }
      case 3: { const v = fieldDouble(f); if (v != null) item.airdate = v; break; }
      case 4: { const v = fieldVarintNum(f); if (v != null) item.duration = v; break; }
      case 5: if (f.wire === 2) item.sites.push(parseEpisodeSite(f.bytes)); break;
      case 6: if (f.wire === 2) item.rating.push(parseEpisodeRating(f.bytes)); break;
      case 7: { const v = fieldString(f); if (v != null) item.image = v; break; }
      case 8: { const v = fieldString(f); if (v != null) item.title = v; break; }
      case 9: { const v = fieldString(f); if (v != null) item.overview = v; break; }
    }
  }, { status: false, sort: 0, airdate: 0, duration: 0, sites: [], rating: [], image: "", title: "", overview: "" });
}

export function parseEpisodes(data: Uint8Array): Episode[] {
  const normalized = normalizeWireData(data);
  const episodes: Episode[] = [];
  for (const f of iterateFields(normalized)) {
    if (f.num === 1 && f.wire === 2) episodes.push(parseEpisode(f.bytes));
  }
  return episodes;
}

/* ---------- Related ---------- */
export function parseBangumiRelatedItem(data: Uint8Array): BangumiRelatedItem {
  return parseItem(data, (f, item: BangumiRelatedItem) => {
    switch (f.num) {
      case 1: { const v = fieldVarintNum(f); if (v != null) item.id = v; break; }
      case 2: { const v = fieldString(f); if (v != null) item.title = v; break; }
      case 3: { const v = fieldString(f); if (v != null) item.name = v; break; }
      case 4: { const v = fieldVarintNum(f); if (v != null) item.episode = v; break; }
      case 5: { const v = fieldVarintNum(f); if (v != null) item.episodesTotal = v; break; }
      case 6: { const v = fieldString(f); if (v != null) item.status = v; break; }
      case 7: { const v = fieldDouble(f); if (v != null) item.date = v; break; }
      case 8: { const v = fieldString(f); if (v != null) item.image = v; break; }
      case 9: { const v = fieldString(f); if (v != null) item.tagline = v; break; }
      case 10: { const v = fieldString(f); if (v != null) item.type = v; break; }
    }
  }, { id: 0, title: "", name: "", episode: 0, episodesTotal: 0, status: "", date: 0, image: "", tagline: "", type: "" });
}

export function parseBangumiRelated(data: Uint8Array): BangumiRelatedItem[] {
  const normalized = normalizeWireData(data);
  const out: BangumiRelatedItem[] = [];
  for (const f of iterateFields(normalized)) {
    if (f.num === 1 && f.wire === 2) out.push(parseBangumiRelatedItem(f.bytes));
  }
  return out;
}

/* ---------- Characters / Persons ---------- */
function parseCharacterActor(data: Uint8Array): BangumiCharacterActor {
  return parseItem(data, (f, item: BangumiCharacterActor) => {
    switch (f.num) {
      case 1: { const v = fieldVarintNum(f); if (v != null) item.id = v; break; }
      case 2: { const v = fieldString(f); if (v != null) item.name = v; break; }
      case 3: { const v = fieldString(f); if (v != null) item.image = v; break; }
    }
  }, { id: 0, name: "", image: "" });
}

export function parseCharacterCredit(data: Uint8Array): BangumiCharacterCredit {
  return parseItem(data, (f, item: BangumiCharacterCredit) => {
    switch (f.num) {
      case 1: { const v = fieldVarintNum(f); if (v != null) item.id = v; break; }
      case 2: { const v = fieldString(f); if (v != null) item.role = v; break; }
      case 3: { const v = fieldString(f); if (v != null) item.name = v; break; }
      case 4: { const v = fieldString(f); if (v != null) item.image = v; break; }
      case 5: if (f.wire === 2) item.actors.push(parseCharacterActor(f.bytes)); break;
    }
  }, { id: 0, role: "", name: "", image: "", actors: [] });
}

export function parseBangumiCharacters(data: Uint8Array): BangumiCharacterCredit[] {
  const normalized = normalizeWireData(data);
  const out: BangumiCharacterCredit[] = [];
  for (const f of iterateFields(normalized)) {
    if (f.num === 1 && f.wire === 2) out.push(parseCharacterCredit(f.bytes));
  }
  return out;
}

export function parsePersonCredit(data: Uint8Array): BangumiPersonCredit {
  return parseItem(data, (f, item: BangumiPersonCredit) => {
    switch (f.num) {
      case 1: { const v = fieldVarintNum(f); if (v != null) item.id = v; break; }
      case 2: { const v = fieldString(f); if (v != null) item.name = v; break; }
      case 3: { const v = fieldString(f); if (v != null) item.image = v; break; }
      case 4: { const v = fieldString(f); if (v != null) item.jobs = v; break; }
    }
  }, { id: 0, name: "", image: "", jobs: "" });
}

export function parseBangumiPersons(data: Uint8Array): BangumiPersonCredit[] {
  const normalized = normalizeWireData(data);
  const out: BangumiPersonCredit[] = [];
  for (const f of iterateFields(normalized)) {
    if (f.num === 1 && f.wire === 2) out.push(parsePersonCredit(f.bytes));
  }
  return out;
}

/* ---------- VOD ---------- */
function parsePlaybackSource(data: Uint8Array): PlaybackSource {
  return parseItem(data, (f, item: PlaybackSource) => {
    switch (f.num) {
      case 1: { const v = fieldString(f); if (v != null) item.rawURL = v; break; }
      case 2: { const v = fieldVarintNum(f); if (v != null) item.sort = v; break; }
      case 3: { const v = fieldString(f); if (v != null) item.type = v; break; }
      case 4: { const v = fieldString(f); if (v != null) item.caption = v; break; }
    }
  }, { rawURL: "", url: "", sort: 0, type: "", caption: "" });
}

export function parseVOD(data: Uint8Array): { sources: PlaybackSource[] } {
  const normalized = normalizeWireData(data);
  const sources: PlaybackSource[] = [];
  for (const f of iterateFields(normalized)) {
    if (f.num === 1 && f.wire === 2) sources.push(parsePlaybackSource(f.bytes));
  }
  return { sources };
}
