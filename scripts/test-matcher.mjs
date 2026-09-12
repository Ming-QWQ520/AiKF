/**
 * 季数感知严格匹配算法单测（镜像 src/lib/bangumi/sync.ts 的 titlesMatch 逻辑）。
 * 用 node scripts/test-matcher.mjs 运行；任何 FAIL 都视为回归。
 */
function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』()（）\[\]【】·・:：,，。.!?！？'"'"~～\-—_+*]/g, "");
}
function normalizeDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}
function cnNumToArabic(s) {
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === "十") return 10;
  const m = s.match(/^([一二三四五六七八九])?十(.*)$/);
  if (m) {
    const tens = (m[1] ? d[m[1]] : 1) * 10;
    const ones = m[2] && d[m[2]] !== undefined ? d[m[2]] : 0;
    return tens + ones;
  }
  return d[s] !== undefined ? d[s] : Number.NaN;
}
const ROMAN = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
function seasonOf(raw) {
  const t = raw || "";
  let m = t.match(/第\s*([0-9０-９一二三四五六七八九十百]+)\s*[季期]/);
  if (m) {
    const n = cnNumToArabic(normalizeDigits(m[1]));
    if (Number.isFinite(n) && n > 0) return n;
  }
  m = t.match(/season\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/(\d+)\s*(?:nd|rd|th)\s*season/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/(?:^|\s)(II|III|IV|V|VI|VII|VIII|IX|X)$/);
  if (m) return ROMAN[m[1]];
  return 1;
}
function stripSeason(raw) {
  return (raw || "")
    .replace(/第\s*[0-9０-９一二三四五六七八九十百]+\s*[季期]/g, " ")
    .replace(/\s*season\s*\d+/gi, " ")
    .replace(/\s*(\d+)\s*(?:nd|rd|th)\s*season/gi, " ")
    .replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/g, "");
}
function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = seasonOf(a);
  const sb = seasonOf(b);
  if (sa !== sb) return false;
  const ca = normalizeTitle(stripSeason(a));
  const cb = normalizeTitle(stripSeason(b));
  return !!ca && ca === cb;
}

const CASES = [
  // ── 必须接受（同一部番）──
  ["剑来 第二季", "剑来 第二季", true, "同题精确"],
  ["孤独摇滚！", "孤独摇滚!", true, "标点差异"],
  ["俺物語!!", "俺物語", true, "感叹号差异"],
  ["葬送的芙莉莲", "葬送的芙莉莲", true, "完全相同"],
  [" Spy × Family  ", "spy×family", true, "空白大小写"],
  ["间谍过家家 第2期", "间谍过家家 第二期", true, "第X期+数字/中文数字"],
  ["DANDADAN Season 2", "ダンダダン Season2", false, "不同语言主体不得凭季数匹配"],
  ["Re:Zero kara Hajimeru Isekai Seikatsu", "Re:Zero kara Hajimeru Isekai Seikatsu", true, "长题"],
  ["无职转生 II", "无职转生 II", true, "罗马数字同题"],
  ["总务组活动记录", "总务组活动记录", true, "普通标题"],
  // ── 必须拒绝（旧算法会误配的场合）──
  ["剑来 第二季", "剑来", false, "核心修复：第二季≠第一季"],
  ["剑来 第二季", "剑来 第三季", false, "第二季≠第三季"],
  ["东京喰种", "东京喰种:re", false, "原作≠:re"],
  ["擅长捉弄的高木同学", "擅长捉弄的高木同学3", false, "无季≠第3季"],
  ["擅長捉弄的高木同學", "擅长捉弄的高木同学", false, "繁简不同字面（宁缺毋滥）"],
  ["少女乐队的呐喊", "Girls Band Cry", false, "中文名≠英文名"],
  ["无职转生", "无职转生 II", false, "第一季≠罗马数字第二季"],
  ["某人物语 season 1", "某人物语 season 2", false, "Season 1≠Season 2"],
];

let fail = 0;
for (const [a, b, expect, why] of CASES) {
  const got = titlesMatch(a, b);
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${JSON.stringify(a)} vs ${JSON.stringify(b)} → ${got}（期望 ${expect}）· ${why}`);
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
