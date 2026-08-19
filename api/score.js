const MATCH_URL =
  process.env.MATCH_URL ||
  "https://www.cricbuzz.com/live-cricket-scores/129579/pak-vs-eng-1st-test-pakistan-tour-of-england-2026";

const SCORECARD_MARKER = "scorecardApiData";
const LIVE_MARKER_CANDIDATES = ["miniscore", "matchScoreDetails", "liveApiData", "commentaryApiData", "faceoffApiData"];
const RECENT_KEY_CANDIDATES = ["recentOvsStats", "recentOvers", "recentBalls", "recentScores", "recent"];
const SQUAD_TEAM_KEYS = ["team1", "team2"];
const PLAYER_LIST_KEYS = ["players", "playerList", "squad", "playing11", "playingXI", "playersList"];

// Commentary feed + win probability markers. Commentary is reduced to a
// single "current ball" snapshot that overwrites itself every poll instead
// of accumulating a growing list.
const COMMENTARY_MARKER = "matchCommentary";
const WIN_PROBABILITY_MARKER = "winProbability";
const EXTRA_LIVE_MARKERS = [COMMENTARY_MARKER, WIN_PROBABILITY_MARKER];
const RUN_WORD_LABELS = { one: "1 run", two: "2 runs", three: "3 runs", five: "5 runs" };

const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 400;
const CACHE_TTL_MS = 15000;

// How long a single upstream (Cricbuzz) request is allowed to hang before
// it's aborted. Keeps one slow request from burning the whole Vercel
// function-duration budget (Hobby plan caps this at 10s).
const FETCH_TIMEOUT_MS = 8000;

const NF = "-";

// In-memory cache (survives only while the serverless instance stays warm).
let CACHE = { data: null, expires: 0 };
// De-dupes concurrent requests that land while a fetch is already running,
// so a burst of hits never turns into a burst of Cricbuzz requests.
let INFLIGHT = null;

function extractMatchIdFromLink(link) {
  const m = String(link).match(/cricbuzz\.com\/live-cricket-(?:scores|scorecard)\/(\d{4,20})\//);
  return m ? m[1] : null;
}

function nf(value) {
  if (value === null || value === undefined) return NF;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length === 0 || t.toLowerCase() === "not found") return NF;
    return t;
  }
  return value;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  // Let Vercel's edge network serve repeat hits straight from cache instead
  // of re-invoking this function (and re-hitting Cricbuzz) every time —
  // this is the main lever for staying inside the Hobby plan's invocation
  // budget and keeping Cricbuzz request volume (and IP-block risk) low even
  // under continuous polling.
  res.setHeader("cache-control", `public, s-maxage=${Math.floor(CACHE_TTL_MS / 1000)}, stale-while-revalidate=60`);
  res.setHeader("content-type", "application/json;charset=UTF-8");

  if (CACHE.data && Date.now() < CACHE.expires) {
    return res.status(200).send(JSON.stringify(CACHE.data, null, 2));
  }

  try {
    if (!INFLIGHT) {
      INFLIGHT = buildResult().finally(() => {
        INFLIGHT = null;
      });
    }
    const outcome = await INFLIGHT;
    if (outcome.error) {
      return res.status(outcome.status).send(JSON.stringify(outcome.body));
    }
    CACHE = { data: outcome.body, expires: Date.now() + CACHE_TTL_MS };
    return res.status(200).send(JSON.stringify(outcome.body, null, 2));
  } catch (e) {
    return res.status(500).send(JSON.stringify({ status: "error", message: String(e) }));
  }
};

async function buildResult() {
  const matchId = extractMatchIdFromLink(MATCH_URL);
  if (!matchId) {
    return { error: true, status: 422, body: { status: "error", message: "invalid MATCH_URL" } };
  }

  const cacheBuster = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const scorecardUrl = `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}?_cb=${cacheBuster}`;
  const liveScoresUrl = `https://www.cricbuzz.com/live-cricket-scores/${matchId}?_cb=${cacheBuster}`;
  const squadsUrl = `https://www.cricbuzz.com/cricket-match-squads/${matchId}?_cb=${cacheBuster}`;

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Referer: "https://www.cricbuzz.com/",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  };

  try {
    const [scorecardRes, liveRes, squadsRes] = await Promise.all([
      fetchWithTimeout(scorecardUrl, { headers }, FETCH_TIMEOUT_MS),
      fetchWithTimeout(liveScoresUrl, { headers }, FETCH_TIMEOUT_MS).catch(() => null),
      fetchWithTimeout(squadsUrl, { headers }, FETCH_TIMEOUT_MS).catch(() => null),
    ]);

    if (!scorecardRes.ok) {
      return { error: true, status: 502, body: { status: "error", message: "cricbuzz fetch failed: " + scorecardRes.status } };
    }
    const html = await scorecardRes.text();
    const liveHtml = liveRes && liveRes.ok ? await liveRes.text() : "";
    const squadsHtml = squadsRes && squadsRes.ok ? await squadsRes.text() : "";

    if (html.length > MAX_HTML_BYTES || liveHtml.length > MAX_HTML_BYTES || squadsHtml.length > MAX_HTML_BYTES) {
      return { error: true, status: 502, body: { status: "error", message: "page too large to process safely" } };
    }

    let scorecardRaw = splitRawChunks(html);
    let liveRaw = liveHtml ? splitRawChunks(liveHtml) : [];
    let squadsRaw = squadsHtml ? splitRawChunks(squadsHtml) : [];
    if (scorecardRaw.length > MAX_CHUNKS) scorecardRaw = scorecardRaw.slice(0, MAX_CHUNKS);
    if (liveRaw.length > MAX_CHUNKS) liveRaw = liveRaw.slice(0, MAX_CHUNKS);
    if (squadsRaw.length > MAX_CHUNKS) squadsRaw = squadsRaw.slice(0, MAX_CHUNKS);
    const scorecardCache = new Map();
    const liveCache = new Map();
    const squadsCache = new Map();

    const scorecardNeededMarkers = [SCORECARD_MARKER, ...LIVE_MARKER_CANDIDATES, ...RECENT_KEY_CANDIDATES];
    const scorecardMarkerIndex = buildChunkMarkerIndex(scorecardRaw, scorecardNeededMarkers);
    const liveNeededMarkers = [...LIVE_MARKER_CANDIDATES, ...RECENT_KEY_CANDIDATES, ...EXTRA_LIVE_MARKERS];
    const liveMarkerIndex = liveRaw.length ? buildChunkMarkerIndex(liveRaw, liveNeededMarkers) : new Map();
    const squadsMarkerIndex = squadsRaw.length ? buildChunkMarkerIndex(squadsRaw, SQUAD_TEAM_KEYS) : new Map();

    const data = findMarkerLazy(scorecardRaw, scorecardCache, SCORECARD_MARKER, scorecardMarkerIndex.get(SCORECARD_MARKER));
    if (!data) {
      return { error: true, status: 502, body: { status: "error", message: "could not find scorecardApiData" } };
    }

    const scoreCards = data.scoreCard || [];
    if (scoreCards.length === 0) {
      return { error: true, status: 502, body: { status: "error", message: "no innings data yet" } };
    }

    const current = scoreCards[scoreCards.length - 1];
    const scoreDetails = current.scoreDetails || {};
    const battingTeam = (current.batTeamDetails && current.batTeamDetails.batTeamName) || "";
    const runs = scoreDetails.runs ?? 0;
    const wickets = scoreDetails.wickets ?? 0;
    const overs = String(scoreDetails.overs ?? NF);

    let liveBlob = null;
    for (const marker of LIVE_MARKER_CANDIDATES) {
      let d = findMarkerLazy(liveRaw, liveCache, marker, liveMarkerIndex.get(marker));
      if (d) { liveBlob = { marker, data: d }; break; }
      d = findMarkerLazy(scorecardRaw, scorecardCache, marker, scorecardMarkerIndex.get(marker));
      if (d) { liveBlob = { marker, data: d }; break; }
    }

    let batsmen = [];
    let bowlerName = NF;
    let recent = NF;

    if (liveBlob && (liveBlob.data.batsmanStriker || liveBlob.data.batsmanNonStriker)) {
      const bs = liveBlob.data.batsmanStriker || {};
      const bns = liveBlob.data.batsmanNonStriker || {};
      if (bs.batName) batsmen.push({ name: `${bs.batName} *`, score: `${bs.batRuns ?? 0}(${bs.batBalls ?? 0})` });
      if (bns.batName) batsmen.push({ name: bns.batName, score: `${bns.batRuns ?? 0}(${bns.batBalls ?? 0})` });
      const bwlStriker = liveBlob.data.bowlerStriker || {};
      if (bwlStriker.bowlName) bowlerName = bwlStriker.bowlName;
      if (liveBlob.data.recentOvsStats) recent = String(liveBlob.data.recentOvsStats);
    }

    if (batsmen.length === 0) {
      batsmen = extractBatsmen(current);
      if (batsmen.length > 0) batsmen[0].name = `${batsmen[0].name} *`;
    }
    batsmen = batsmen.slice(0, 2);
    while (batsmen.length < 2) batsmen.push({ name: NF, score: NF });

    if (bowlerName === NF) {
      const bowlersData = (current.bowlTeamDetails && current.bowlTeamDetails.bowlersData) || {};
      let bestOvers = -1;
      let midOverBowler = null;
      for (const key of Object.keys(bowlersData)) {
        const bw = bowlersData[key];
        const ov = parseFloat(bw.overs ?? 0);
        if (!isNaN(ov) && ov % 1 !== 0) midOverBowler = bw.bowlName;
        if (!isNaN(ov) && ov > bestOvers) { bestOvers = ov; bowlerName = bw.bowlName || NF; }
      }
      if (midOverBowler) bowlerName = midOverBowler;
    }

    if (recent === NF) {
      for (const key of RECENT_KEY_CANDIDATES) {
        let hit = findKeyLazy(scorecardRaw, scorecardCache, key, scorecardMarkerIndex.get(key));
        if (!hit) hit = findKeyLazy(liveRaw, liveCache, key, liveMarkerIndex.get(key));
        if (hit) {
          recent = Array.isArray(hit) ? hit.join(", ") : String(hit).trim();
          break;
        }
      }
    }

    const matchInfo = extractMatchInfo(data.matchHeader || {});
    const fullScore = buildFullScoreSummary(scoreCards);

    let squads;
    const directParsed = findSquadsObjectDirect(squadsRaw, squadsCache);
    if (directParsed) {
      squads = {
        team1: extractTeamNameAndPlayers(directParsed.team1),
        team2: extractTeamNameAndPlayers(directParsed.team2),
      };
    } else {
      const team1Candidates = findAllMarkerObjects(squadsRaw, squadsCache, "team1", squadsMarkerIndex.get("team1"));
      const team2Candidates = findAllMarkerObjects(squadsRaw, squadsCache, "team2", squadsMarkerIndex.get("team2"));
      const fallbackTeam1 = (data.matchHeader && data.matchHeader.team1) || null;
      const fallbackTeam2 = (data.matchHeader && data.matchHeader.team2) || null;
      squads = extractSquadsFuzzy(team1Candidates, team2Candidates, fallbackTeam1, fallbackTeam2);
    }

    const result = {
      status: "success",
      match: nf(matchInfo.match),
      toss: nf(matchInfo.toss),
      venue: nf(matchInfo.venue),
      team: nf(battingTeam),
      score: `${runs}/${wickets}`,
      overs,
      matchScore: fullScore, // e.g. "SL 284 & 175/6 vs IND 462 & 193"
      batsmen: batsmen.map((b) => ({ name: nf(b.name), score: nf(b.score) })),
      bowler: nf(bowlerName),
      recent: nf(recent),
      squads,
    };

    try {
      const matchInfoBlob = findRichMatchInfo(liveRaw, liveCache) || findRichMatchInfo(scorecardRaw, scorecardCache);
      const extended = extractExtendedMatchInfo(data.matchHeader || {}, matchInfoBlob);

      result.matchMeta = {
        format: nf(extended.meta.format),
        dayNumber: nf(extended.meta.dayNumber),
        dayNight: extended.meta.dayNight === undefined ? NF : extended.meta.dayNight,
        state: nf(extended.meta.state),
        shortStatus: nf(extended.meta.shortStatus),
      };

      result.officials = {
        umpire1: nf(extended.officials.umpire1),
        umpire2: nf(extended.officials.umpire2),
        umpire3: nf(extended.officials.umpire3),
        referee: nf(extended.officials.referee),
      };

      // Key Stats: partnership, last wicket, overs left, last 10 overs, toss
      result.keyStats = extractKeyStats(liveBlob ? liveBlob.data : null, data.matchHeader || {});

      // Win probability (e.g. SL 5% / IND 94% / Draw 1%)
      const winProb = extractWinProbability(
        findMarkerLazy(liveRaw, liveCache, WIN_PROBABILITY_MARKER, liveMarkerIndex.get(WIN_PROBABILITY_MARKER)) ||
          findMarkerLazy(scorecardRaw, scorecardCache, WIN_PROBABILITY_MARKER, scorecardMarkerIndex.get(WIN_PROBABILITY_MARKER))
      );
      result.winProbability = winProb || NF;

      // Current ball snapshot only (four / six / wicket / dot / N run) —
      // overwrites in place every poll, never accumulates a list.
      const commentaryData =
        findMarkerLazy(liveRaw, liveCache, COMMENTARY_MARKER, liveMarkerIndex.get(COMMENTARY_MARKER)) ||
        findMarkerLazy(scorecardRaw, scorecardCache, COMMENTARY_MARKER, scorecardMarkerIndex.get(COMMENTARY_MARKER));
      const currentBall = extractCurrentBall(commentaryData);
      result.commentary = currentBall || NF;
    } catch (e) {
      if (!result.matchMeta) result.matchMeta = NF;
      if (!result.officials) result.officials = NF;
      if (!result.keyStats) result.keyStats = NF;
      if (!result.winProbability) result.winProbability = NF;
      if (!result.commentary) result.commentary = NF;
    }

    return { error: false, body: result };
  } catch (e) {
    return { error: true, status: 500, body: { status: "error", message: String(e) } };
  }
}

function extractMatchInfo(matchHeader) {
  const team1Name = (matchHeader.team1 && (matchHeader.team1.shortName || matchHeader.team1.name)) || "";
  const team2Name = (matchHeader.team2 && (matchHeader.team2.shortName || matchHeader.team2.name)) || "";
  const seriesName = (matchHeader.series && matchHeader.series.name) || matchHeader.seriesName || "";
  const desc = matchHeader.matchDescription || matchHeader.matchFormat || "";
  const matchParts = [team1Name && team2Name ? `${team1Name} vs ${team2Name}` : "", desc, seriesName].filter(Boolean);
  const match = matchParts.length ? matchParts.join(" • ") : NF;
  const toss = matchHeader.tossResults
    ? `${matchHeader.tossResults.tossWinnerName || NF} won the toss and opt to ${matchHeader.tossResults.decision || NF}`
    : matchHeader.tossStatus || NF;
  const venueObj = matchHeader.venue || {};
  const venueParts = [venueObj.ground || venueObj.name, venueObj.city].filter(Boolean);
  const venue = venueParts.length ? venueParts.join(", ") : NF;
  return { match, toss, venue };
}

// ---------------------------------------------------------------------
// Full match score across all innings, per team, e.g.
// "SL 284 & 175/6 vs IND 462 & 193"
// ---------------------------------------------------------------------
function formatInningsScore(scoreDetails) {
  const sd = scoreDetails || {};
  const runs = sd.runs ?? 0;
  const wickets = sd.wickets ?? 0;
  const isDeclared = sd.declared === true || sd.isDeclared === true;
  let str = wickets >= 10 ? `${runs}` : `${runs}/${wickets}`;
  if (isDeclared) str += "d";
  return str;
}

function buildFullScoreSummary(scoreCards) {
  const order = [];
  const byTeam = new Map();
  for (const card of scoreCards || []) {
    const teamDetails = card.batTeamDetails || {};
    const teamName = teamDetails.batTeamShortName || teamDetails.batTeamName || "";
    if (!teamName) continue;
    if (!byTeam.has(teamName)) {
      byTeam.set(teamName, []);
      order.push(teamName);
    }
    byTeam.get(teamName).push(formatInningsScore(card.scoreDetails));
  }
  if (order.length === 0) return NF;
  return order.map((team) => `${team} ${byTeam.get(team).join(" & ")}`).join(" vs ");
}

function findBalancedEnd(str, startIdx, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  for (let j = startIdx; j < str.length; j++) {
    const c = str[j];
    if (inString) {
      if (c === "\\") { j++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function findSquadsObjectDirect(rawChunks, cache) {
  const FINGERPRINT = '"team1":{"team":';
  for (let i = 0; i < rawChunks.length; i++) {
    const decoded = decodeChunk(rawChunks, i, cache);
    const idx = decoded.indexOf(FINGERPRINT);
    if (idx === -1) continue;
    const objStart = idx - 1;
    if (objStart < 0 || decoded[objStart] !== "{") continue;
    const end = findBalancedEnd(decoded, objStart, "{", "}");
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(decoded.slice(objStart, end + 1));
      if (parsed && parsed.team1 && parsed.team2) return parsed;
    } catch (e) { continue; }
  }
  return null;
}

function extractTeamNameAndPlayers(teamObj) {
  if (!teamObj) return { name: NF, players: [] };
  const teamInfo = teamObj.team || {};
  const name = teamInfo.teamName || teamInfo.name || teamInfo.teamSName || NF;
  const playersObj = teamObj.players || {};
  const keys = Object.keys(playersObj);
  let playingArr = null;
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower.includes("bench") || lower.includes("support")) continue;
    if (!Array.isArray(playersObj[key])) continue;
    if (lower.includes("playing") || lower.includes("xi") || lower.includes("11")) {
      playingArr = playersObj[key];
      break;
    }
  }
  if (!playingArr) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (lower.includes("bench") || lower.includes("support")) continue;
      if (Array.isArray(playersObj[key])) { playingArr = playersObj[key]; break; }
    }
  }
  return { name, players: extractPlayerNames(playingArr || []) };
}

function extractPlayerNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => (typeof p === "string" ? p : (p && (p.name || p.playerName || p.fullName)) || null))
    .filter(Boolean);
}

function flattenToPlayerArray(value, depth) {
  depth = depth || 0;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && depth < 2) {
    for (const key of PLAYER_LIST_KEYS) {
      if (Array.isArray(value[key]) && value[key].length > 0) return value[key];
    }
    let best = [];
    for (const k of Object.keys(value)) {
      const v = value[k];
      const flat = Array.isArray(v) ? v : flattenToPlayerArray(v, depth + 1);
      if (flat.length > best.length) best = flat;
    }
    return best;
  }
  return [];
}

function findPlayersArray(teamObj) {
  for (const key of PLAYER_LIST_KEYS) {
    const val = teamObj[key];
    if (Array.isArray(val) && val.length > 0) return val;
    if (val && typeof val === "object") {
      const nested = flattenToPlayerArray(val);
      if (nested.length > 0) return nested;
    }
  }
  let best = [];
  for (const key of Object.keys(teamObj)) {
    const val = teamObj[key];
    let candidate = Array.isArray(val) ? val : flattenToPlayerArray(val);
    if (candidate.length === 0) continue;
    const looksLikePlayers = candidate.every(
      (p) => typeof p === "string" || (p && typeof p === "object" && (p.name || p.playerName || p.fullName || p.id))
    );
    if (looksLikePlayers && candidate.length > best.length) best = candidate;
  }
  return best;
}

function pickBestTeamObject(candidates) {
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const list = findPlayersArray(c);
    if (list.length > bestScore) { bestScore = list.length; best = c; }
  }
  return best;
}

function extractSquadsFuzzy(team1Candidates, team2Candidates, fallbackTeam1, fallbackTeam2) {
  const build = (candidates, fallbackObj) => {
    let obj = candidates && candidates.length > 0 ? pickBestTeamObject(candidates) : null;
    let list = obj ? findPlayersArray(obj) : [];
    if (list.length === 0 && fallbackObj && !obj) obj = fallbackObj;
    if (!obj) return { name: NF, players: [] };
    const name = obj.teamName || obj.name || obj.shortName || (fallbackObj && (fallbackObj.name || fallbackObj.shortName)) || NF;
    return { name, players: extractPlayerNames(list) };
  };
  return {
    team1: build(team1Candidates, fallbackTeam1),
    team2: build(team2Candidates, fallbackTeam2),
  };
}

function extractBatsmen(current) {
  const teamNode = current.batTeamDetails || current.battingTeamDetails || current.batTeam || current.batting || {};
  const rosterCandidates = [
    teamNode.batsmenData, teamNode.batsmenList, teamNode.batsman,
    teamNode.batters, teamNode.players, current.batsmenData,
  ];
  const roster = rosterCandidates.find((r) => r && (Array.isArray(r) ? r.length > 0 : Object.keys(r).length > 0));
  if (!roster) return [];
  const entries = Array.isArray(roster) ? roster : Object.values(roster);
  const notOut = [];
  for (const b of entries) {
    if (!b || typeof b !== "object") continue;
    const name = b.batName || b.name || b.batsman || b.playerName || b.fullName || null;
    if (!name) continue;
    const outDesc = b.outDesc ?? b.dismissal ?? b.outDescription ?? "";
    const isOut = b.isOut === true || (typeof outDesc === "string" && outDesc.trim().length > 0 && outDesc.trim().toLowerCase() !== "not out" && outDesc.trim().toLowerCase() !== "batting");
    if (isOut) continue;
    const runs = b.runs ?? b.batRuns ?? b.r ?? 0;
    const balls = b.balls ?? b.batBalls ?? b.b ?? 0;
    notOut.push({ name, score: `${runs}(${balls})` });
  }
  return notOut;
}

function splitRawChunks(html) {
  const chunks = [];
  let searchFrom = 0;
  while (true) {
    const start = html.indexOf("self.__next_f.push", searchFrom);
    if (start === -1) break;
    const rest = html.slice(start);
    const innerStart = rest.indexOf('"') + 1;
    let endIdx = rest.indexOf('"]\n', innerStart);
    if (endIdx === -1) endIdx = rest.indexOf('"])', innerStart);
    if (endIdx === -1) { searchFrom = start + 1; continue; }
    chunks.push(rest.slice(innerStart, endIdx));
    searchFrom = start + endIdx;
  }
  return chunks;
}

function rawChunkMayContain(rawEscaped, key) {
  return rawEscaped.indexOf('\\"' + key + '\\"') !== -1;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildChunkMarkerIndex(rawChunks, markers) {
  const uniqueMarkers = Array.from(new Set(markers));
  const index = new Map(uniqueMarkers.map((m) => [m, []]));
  if (uniqueMarkers.length === 0 || rawChunks.length === 0) return index;
  const combined = new RegExp('\\\\"(?:' + uniqueMarkers.map(escapeRegex).join("|") + ')\\\\"');
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i];
    if (!combined.test(chunk)) continue;
    for (const m of uniqueMarkers) {
      if (rawChunkMayContain(chunk, m)) index.get(m).push(i);
    }
  }
  return index;
}

function decodeChunk(rawChunks, idx, cache) {
  if (cache.has(idx)) return cache.get(idx);
  const rawEscaped = rawChunks[idx];
  let decoded;
  try {
    decoded = JSON.parse('"' + rawEscaped + '"');
  } catch (e) {
    decoded = rawEscaped.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\");
  }
  cache.set(idx, decoded);
  return decoded;
}

function findMarkerLazy(rawChunks, cache, marker, candidateIndices) {
  const indices = candidateIndices || rawChunks.map((_, i) => i);
  for (const i of indices) {
    const decoded = decodeChunk(rawChunks, i, cache);
    const idx = decoded.indexOf(`"${marker}"`);
    if (idx === -1) continue;
    const braceStart = decoded.indexOf("{", idx);
    if (braceStart === -1) continue;
    const end = findBalancedEnd(decoded, braceStart, "{", "}");
    if (end === -1) continue;
    try { return JSON.parse(decoded.slice(braceStart, end + 1)); } catch (e) { continue; }
  }
  return null;
}

function findAllMarkerObjects(rawChunks, cache, marker, candidateIndices, maxResults) {
  maxResults = maxResults || 5;
  const indices = candidateIndices || rawChunks.map((_, i) => i);
  const results = [];
  for (const i of indices) {
    if (results.length >= maxResults) break;
    const decoded = decodeChunk(rawChunks, i, cache);
    let searchFrom = 0;
    while (results.length < maxResults) {
      const idx = decoded.indexOf(`"${marker}"`, searchFrom);
      if (idx === -1) break;
      const braceStart = decoded.indexOf("{", idx);
      if (braceStart === -1) break;
      const end = findBalancedEnd(decoded, braceStart, "{", "}");
      if (end === -1) break;
      try { results.push(JSON.parse(decoded.slice(braceStart, end + 1))); } catch (e) {}
      searchFrom = end + 1;
    }
  }
  return results;
}

function findRichMatchInfo(rawChunks, cache) {
  const FINGERPRINT = '"matchInfo":{';
  for (let i = 0; i < rawChunks.length; i++) {
    const decoded = decodeChunk(rawChunks, i, cache);
    let searchFrom = 0;
    while (true) {
      const idx = decoded.indexOf(FINGERPRINT, searchFrom);
      if (idx === -1) break;
      const braceStart = idx + FINGERPRINT.length - 1;
      const end = findBalancedEnd(decoded, braceStart, "{", "}");
      if (end === -1) { searchFrom = idx + FINGERPRINT.length; continue; }
      try {
        const parsed = JSON.parse(decoded.slice(braceStart, end + 1));
        if (parsed && (parsed.umpire1 || parsed.referee || parsed.series)) return parsed;
      } catch (e) {}
      searchFrom = end + 1;
    }
  }
  return null;
}

function findKeyLazy(rawChunks, cache, key, candidateIndices) {
  const indices = candidateIndices || rawChunks.map((_, i) => i);
  for (const i of indices) {
    const decoded = decodeChunk(rawChunks, i, cache);
    const val = extractValueAfterKey(decoded, key);
    if (val !== undefined && val !== null && String(val).length > 0) return val;
  }
  return null;
}

function extractValueAfterKey(chunk, key) {
  const marker = `"${key}":`;
  const idx = chunk.indexOf(marker);
  if (idx === -1) return undefined;
  let i = idx + marker.length;
  while (i < chunk.length && /\s/.test(chunk[i])) i++;
  const c = chunk[i];

  if (c === '"') {
    let j = i + 1, out = "";
    while (j < chunk.length && chunk[j] !== '"') {
      if (chunk[j] === "\\") { out += chunk[j] + (chunk[j + 1] || ""); j += 2; continue; }
      out += chunk[j]; j++;
    }
    try { return JSON.parse('"' + out + '"'); } catch (e) { return out; }
  }

  if (c === "[" || c === "{") {
    const close = c === "[" ? "]" : "}";
    const end = findBalancedEnd(chunk, i, c, close);
    if (end === -1) return undefined;
    const raw = chunk.slice(i, end + 1);
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  let j = i;
  while (j < chunk.length && !",}]".includes(chunk[j])) j++;
  return chunk.slice(i, j).trim();
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function formatPersonInfo(p) {
  if (!p || typeof p !== "object") return undefined;
  const name = p.name || p.fullName;
  if (!name) return undefined;
  return p.country ? `${name} (${p.country})` : name;
}

function extractExtendedMatchInfo(matchHeader, matchInfoBlob) {
  const mh = matchHeader || {};
  const mi = matchInfoBlob || {};

  return {
    meta: {
      format: firstDefined(mh.matchFormat, mi.matchFormat),
      dayNumber: firstDefined(mi.dayNumber, mh.dayNumber),
      dayNight: firstDefined(mh.dayNight, mi.dayNight),
      state: firstDefined(mh.state, mi.state),
      shortStatus: firstDefined(mi.shortStatus, mh.shortStatus),
    },
    officials: {
      umpire1: formatPersonInfo(mi.umpire1 || mh.umpire1),
      umpire2: formatPersonInfo(mi.umpire2 || mh.umpire2),
      umpire3: formatPersonInfo(mi.umpire3 || mh.umpire3),
      referee: formatPersonInfo(mi.referee || mh.referee),
    },
  };
}

// ---------------------------------------------------------------------
// Key Stats: partnership, last wicket, overs left, last 10 overs, toss
// ---------------------------------------------------------------------
function extractKeyStats(miniscoreData, matchHeader) {
  const md = miniscoreData || {};

  let partnership;
  if (md.partnerShip && typeof md.partnerShip === "object") {
    partnership = `${md.partnerShip.runs ?? 0}(${md.partnerShip.balls ?? 0})`;
  }

  let last10Overs;
  if (Array.isArray(md.latestPerformance)) {
    const entry = md.latestPerformance.find(
      (p) => p && typeof p.label === "string" && p.label.toLowerCase().includes("last 10")
    );
    if (entry) last10Overs = `${entry.runs ?? 0} runs, ${entry.wkts ?? 0} wkts`;
  }

  let toss;
  if (matchHeader && matchHeader.tossResults) {
    const t = matchHeader.tossResults;
    toss = `${t.tossWinnerName || NF} (${t.decision || NF})`;
  }

  return {
    partnership: nf(partnership),
    lastWicket: nf(typeof md.lastWicket === "string" ? md.lastWicket.replace(/\s+/g, " ").trim() : undefined),
    oversLeft: nf(md.oversRem !== undefined ? String(md.oversRem) : undefined),
    last10Overs: nf(last10Overs),
    toss: nf(toss),
  };
}

// ---------------------------------------------------------------------
// Win probability (e.g. SL 5% vs IND 94%, draw/tie 1%)
// ---------------------------------------------------------------------
function extractWinProbability(wp) {
  if (!wp || typeof wp !== "object") return null;
  const team1 = wp.team1 || {};
  const team2 = wp.team2 || {};
  return {
    team1: { name: nf(team1.name), shortName: nf(team1.shortName), percent: team1.percent ?? NF },
    team2: { name: nf(team2.name), shortName: nf(team2.shortName), percent: team2.percent ?? NF },
    drawPercent: wp.drawTiePercent ?? NF,
  };
}

// ---------------------------------------------------------------------
// Current ball only: four / six / wicket / dot / "N run(s)" / extras.
// Always a single object that overwrites itself — never a growing list.
// ---------------------------------------------------------------------
function stripHtmlTags(str) {
  return String(str || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function classifyBallType(entry) {
  const events = Array.isArray(entry.event) ? entry.event.map((e) => String(e).toLowerCase()) : [];
  if (events.includes("wicket")) return "wicket";
  if (events.includes("six")) return "six";
  if (events.includes("four")) return "four";
  if (events.includes("wide")) return "wide";
  if (events.includes("noball") || events.includes("no-ball") || events.includes("no_ball")) return "no ball";
  if (events.includes("bye")) return "bye";
  if (events.includes("legbye") || events.includes("leg-bye") || events.includes("leg_bye")) return "leg bye";
  if (events.includes("penalty")) return "penalty";
  for (const word of Object.keys(RUN_WORD_LABELS)) {
    if (events.includes(word)) return RUN_WORD_LABELS[word];
  }
  return "dot";
}

function extractCurrentBall(commData) {
  if (!commData || typeof commData !== "object") return null;
  const entries = Object.values(commData)
    .filter((e) => e && typeof e === "object" && e.commType === "commentary" && typeof e.ballMetric === "number")
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (entries.length === 0) return null;

  const entry = entries[0];
  return {
    over: String(entry.ballMetric),
    ball: classifyBallType(entry),
    text: nf(stripHtmlTags(entry.commText)),
    batsman: nf(entry.batsmanDetails && entry.batsmanDetails.playerName),
    bowler: nf(entry.bowlerDetails && entry.bowlerDetails.playerName),
    team: nf(entry.teamName),
  };
}
