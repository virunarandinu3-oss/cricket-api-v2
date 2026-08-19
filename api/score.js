// Cricbuzz eken TEAM NAMES + PLAYERS witharak ganna simplified version eka.
// v2 UPDATE: user dunna raw HTML eken squads page eke ida REAL structure
// eka confirm kala -
//   { "team1": { "team": { teamId, teamName, teamSName, ... },
//                "players": { "playing XI": [ {name,...}, ... ],
//                             "bench":      [ {name,...}, ... ] } },
//     "team2": { ...same shape... } }
// "team1"/"team2" deka thani object ekakama keys widiyata thiyenne
// ("$L26" component ekata denna props tika), eka nisa dan guess-scanning
// ekak karanna one na - "\"team1\":{\"team\":" kiyana fingerprint eken
// kelinma object eka locate karala pluck karanawa. Name eka team1.team.teamName,
// players eka team1.players athule thiyena okkoma array (playing XI +
// bench) flatten karala.
// Format wenas una nam / fingerprint eka hamba unේ nathnam, pahala election
// fuzzy candidate-scanning fallback ekata weradi widiyata backup widiyata.
// ================================================================
// ================================================================
//                  MATCH LINK EKA METHANATA DANNA
// ================================================================
const MATCH_URL = "https://www.cricbuzz.com/live-cricket-scores/154410/jkm-vs-snp-10th-match-caribbean-premier-league-2026";
// ================================================================
// ================================================================

const SQUAD_TEAM_KEYS = ["team1", "team2"];
const PLAYER_LIST_KEYS = ["players", "playerList", "squad", "playing11", "playingXI", "playersList"];

const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 400;

const NF = "-"; // "not found" wenuwata methanin danna thani akura

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

module.exports = async function handler(req, res) {
  const debug = req.query.debug === "1";

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");

  const matchId = extractMatchIdFromLink(MATCH_URL);
  if (!matchId) {
    return res.status(422).json({ status: "error", message: "invalid MATCH_URL at top of file" });
  }

  const cacheBuster = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const squadsUrl = `https://www.cricbuzz.com/cricket-match-squads/${matchId}?_cb=${cacheBuster}`;
  const scorecardUrl = `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}?_cb=${cacheBuster}`;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Referer: "https://www.cricbuzz.com/",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  };

  const t0 = Date.now();

  try {
    // squadsUrl eken player lists ganna, scorecardUrl eken matchHeader
    // eke thiyena team1/team2 name (players na) fallback ekata witharak.
    const [squadsRes, scorecardRes] = await Promise.all([
      fetch(squadsUrl, { headers }).catch(() => null),
      fetch(scorecardUrl, { headers }).catch(() => null),
    ]);

    const squadsHtml = squadsRes && squadsRes.ok ? await squadsRes.text() : "";
    const scorecardHtml = scorecardRes && scorecardRes.ok ? await scorecardRes.text() : "";

    if (squadsHtml.length > MAX_HTML_BYTES || scorecardHtml.length > MAX_HTML_BYTES) {
      return res.status(502).json({ status: "error", message: "page too large to process safely" });
    }
    if (!squadsHtml && !scorecardHtml) {
      return res.status(502).json({ status: "error", message: "cricbuzz fetch failed for both squads and scorecard pages" });
    }

    let squadsRaw = squadsHtml ? splitRawChunks(squadsHtml) : [];
    let scorecardRaw = scorecardHtml ? splitRawChunks(scorecardHtml) : [];
    if (squadsRaw.length > MAX_CHUNKS) squadsRaw = squadsRaw.slice(0, MAX_CHUNKS);
    if (scorecardRaw.length > MAX_CHUNKS) scorecardRaw = scorecardRaw.slice(0, MAX_CHUNKS);

    const squadsCache = new Map();
    const scorecardCache = new Map();

    let squads;
    let debugInfo;

    // 1) PRIMARY: direct-parse the known real shape.
    const directParsed = findSquadsObjectDirect(squadsRaw, squadsCache);
    if (directParsed) {
      squads = {
        team1: extractTeamNameAndPlayers(directParsed.team1),
        team2: extractTeamNameAndPlayers(directParsed.team2),
      };
      debugInfo = {
        method: "direct-parse",
        team1_top_keys: Object.keys(directParsed.team1 || {}),
        team2_top_keys: Object.keys(directParsed.team2 || {}),
        team1_players_keys: Object.keys((directParsed.team1 && directParsed.team1.players) || {}),
        team2_players_keys: Object.keys((directParsed.team2 && directParsed.team2.players) || {}),
      };
    } else {
      // 2) FALLBACK: old fuzzy candidate-scanning (in case page format changed).
      const squadsMarkerIndex = squadsRaw.length ? buildChunkMarkerIndex(squadsRaw, SQUAD_TEAM_KEYS) : new Map();
      const team1Candidates = findAllMarkerObjects(squadsRaw, squadsCache, "team1", squadsMarkerIndex.get("team1"));
      const team2Candidates = findAllMarkerObjects(squadsRaw, squadsCache, "team2", squadsMarkerIndex.get("team2"));

      let fallbackTeam1 = null;
      let fallbackTeam2 = null;
      if (scorecardRaw.length) {
        const scMarkerIndex = buildChunkMarkerIndex(scorecardRaw, ["scorecardApiData"]);
        const data = findMarkerLazy(scorecardRaw, scorecardCache, "scorecardApiData", scMarkerIndex.get("scorecardApiData"));
        if (data && data.matchHeader) {
          fallbackTeam1 = data.matchHeader.team1 || null;
          fallbackTeam2 = data.matchHeader.team2 || null;
        }
      }

      const extracted = extractSquadsFuzzy(team1Candidates, team2Candidates, fallbackTeam1, fallbackTeam2);
      squads = extracted.squads;
      debugInfo = { method: "fuzzy-fallback", ...extracted.debugInfo };
    }

    const result = {
      status: "success",
      team1: { name: nf(squads.team1.name), players: squads.team1.players },
      team2: { name: nf(squads.team2.name), players: squads.team2.players },
    };

    if (debug) {
      result.debug = {
        squads_extraction_debug: debugInfo,
        total_ms: Date.now() - t0,
        fetched_at: new Date().toISOString(),
      };
    }

    res.setHeader("content-type", "application/json;charset=UTF-8");
    return res.status(200).send(JSON.stringify(result, null, 2));
  } catch (e) {
    res.setHeader("content-type", "application/json;charset=UTF-8");
    return res.status(500).send(JSON.stringify({ status: "error", message: String(e) }, null, 2));
  }
};

// ---------- PRIMARY: direct-parse the known real squads shape ----------

// Looks for the literal fingerprint `"team1":{"team":` which uniquely
// identifies the squads props blob (as opposed to lightweight team refs
// like matchHeader.team1 which look like {"teamId":2,"teamName":...}
// with no "team" wrapper). Once found, walks back one char to the
// opening `{` of the parent object `{"team1":{...},"team2":{...}}` and
// brace-matches forward to grab the whole thing.
function findSquadsObjectDirect(rawChunks, cache) {
  const FINGERPRINT = '"team1":{"team":';
  for (let i = 0; i < rawChunks.length; i++) {
    const decoded = decodeChunk(rawChunks, i, cache);
    const idx = decoded.indexOf(FINGERPRINT);
    if (idx === -1) continue;

    const objStart = idx - 1;
    if (objStart < 0 || decoded[objStart] !== "{") continue;

    let depth = 0, end = -1;
    for (let j = objStart; j < decoded.length; j++) {
      const c = decoded[j];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;

    try {
      const parsed = JSON.parse(decoded.slice(objStart, end + 1));
      if (parsed && parsed.team1 && parsed.team2) return parsed;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// teamObj = { team: { teamName, teamSName, ... }, players: { "playing XI": [...], "bench": [...] } }
// Flattens EVERY array found under `players` (regardless of the exact
// key names, since they can vary a bit: "playing XI", "bench", maybe
// others for different formats) into one player-name list.
function extractTeamNameAndPlayers(teamObj) {
  if (!teamObj) return { name: NF, players: [] };
  const teamInfo = teamObj.team || {};
  const name = teamInfo.teamName || teamInfo.name || teamInfo.teamSName || NF;

  const playersObj = teamObj.players || {};
  let players = [];
  for (const key of Object.keys(playersObj)) {
    const arr = playersObj[key];
    if (Array.isArray(arr)) players = players.concat(extractPlayerNames(arr));
  }
  return { name, players };
}

function extractPlayerNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => (typeof p === "string" ? p : (p && (p.name || p.playerName || p.fullName)) || null))
    .filter(Boolean);
}

// ---------- FALLBACK: old fuzzy candidate-scanning ----------

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

function findPlayersArrayWithSource(teamObj) {
  for (const key of PLAYER_LIST_KEYS) {
    const val = teamObj[key];
    if (Array.isArray(val) && val.length > 0) return { list: val, sourceKey: key };
    if (val && typeof val === "object") {
      const nested = flattenToPlayerArray(val);
      if (nested.length > 0) return { list: nested, sourceKey: `${key}.<nested>` };
    }
  }

  let bestKey = null;
  let best = [];
  for (const key of Object.keys(teamObj)) {
    const val = teamObj[key];
    let candidate = Array.isArray(val) ? val : flattenToPlayerArray(val);
    if (candidate.length === 0) continue;
    const looksLikePlayers = candidate.every(
      (p) => typeof p === "string" || (p && typeof p === "object" && (p.name || p.playerName || p.fullName || p.id))
    );
    if (looksLikePlayers && candidate.length > best.length) { best = candidate; bestKey = key; }
  }
  return { list: best, sourceKey: bestKey ? `fallback:${bestKey}` : null };
}

function pickBestTeamObject(candidates) {
  let best = null;
  let bestScore = -1;
  let bestFind = { list: [], sourceKey: null };
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const found = findPlayersArrayWithSource(c);
    if (found.list.length > bestScore) {
      bestScore = found.list.length;
      best = c;
      bestFind = found;
    }
  }
  return { obj: best, playersFind: bestFind };
}

function extractSquadsFuzzy(team1Candidates, team2Candidates, fallbackTeam1, fallbackTeam2) {
  const debugInfo = { teams: [] };

  const build = (candidates, fallbackObj) => {
    let obj = null;
    let source = "not found";

    if (candidates && candidates.length > 0) {
      const picked = pickBestTeamObject(candidates);
      if (picked.obj) {
        obj = picked.obj;
        source = picked.playersFind.list.length > 0
          ? `squads-page (${candidates.length} candidate(s) checked)`
          : `squads-page (${candidates.length} candidate(s), no players array found in any)`;
      }
    }

    let list = [];
    let sourceKey = null;
    if (obj) {
      const found = findPlayersArrayWithSource(obj);
      list = found.list;
      sourceKey = found.sourceKey;
    }

    if (list.length === 0 && fallbackObj) {
      if (!obj) { obj = fallbackObj; source = "matchHeader fallback (name only, no players array on squads page)"; }
      else source += " + matchHeader fallback for name";
    }

    if (!obj) {
      debugInfo.teams.push({ found: false, source, candidates_checked: candidates ? candidates.length : 0 });
      return { name: NF, players: [] };
    }

    const name = obj.teamName || obj.name || obj.shortName || (fallbackObj && (fallbackObj.name || fallbackObj.shortName)) || NF;
    debugInfo.teams.push({
      name,
      source,
      team_object_keys: Object.keys(obj),
      players_source_key: sourceKey,
      players_count: list.length,
      candidates_checked: candidates ? candidates.length : 0,
    });
    return { name, players: extractPlayerNames(list) };
  };

  const squads = {
    team1: build(team1Candidates, fallbackTeam1),
    team2: build(team2Candidates, fallbackTeam2),
  };
  return { squads, debugInfo };
}

// ---------- chunk parsing helpers (unchanged) ----------

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
    let depth = 0, end = -1;
    for (let j = braceStart; j < decoded.length; j++) {
      const c = decoded[j];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
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
      let depth = 0, end = -1;
      for (let j = braceStart; j < decoded.length; j++) {
        const c = decoded[j];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end === -1) break;
      try {
        results.push(JSON.parse(decoded.slice(braceStart, end + 1)));
      } catch (e) {
        // ignore, keep scanning
      }
      searchFrom = end + 1;
    }
  }
  return results;
}
