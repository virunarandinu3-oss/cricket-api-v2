// Cricbuzz eke match eke link eka methanata danna:
const MATCH_URL = "https://www.cricbuzz.com/live-cricket-scores/163013/";

const SCORECARD_MARKER = "scorecardApiData";
const LIVE_MARKER_CANDIDATES = ["miniscore", "matchScoreDetails", "liveApiData", "commentaryApiData", "faceoffApiData"];
const RECENT_KEY_CANDIDATES = ["recentOvsStats", "recentOvers", "recentBalls", "recentScores", "recent"];
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 400;

function extractMatchIdFromLink(link) {
  const m = String(link).match(/cricbuzz\.com\/live-cricket-(?:scores|scorecard)\/(\d{4,20})\//);
  return m ? m[1] : null;
}

module.exports = async function handler(req, res) {
  const debug = req.query.debug === "1";
  const scan = req.query.scan === "1";

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");

  const matchId = extractMatchIdFromLink(MATCH_URL);
  if (!matchId) {
    return res.status(422).json({ status: "error", message: "invalid MATCH_URL at top of file" });
  }

  const cacheBuster = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const scorecardUrl = `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}?_cb=${cacheBuster}`;
  const liveScoresUrl = `https://www.cricbuzz.com/live-cricket-scores/${matchId}?_cb=${cacheBuster}`;

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
    const [scorecardRes, liveRes] = await Promise.all([
      fetch(scorecardUrl, { headers }),
      fetch(liveScoresUrl, { headers }).catch(() => null),
    ]);

    if (!scorecardRes.ok) {
      return res.status(502).json({ status: "error", message: "cricbuzz fetch failed: " + scorecardRes.status });
    }
    const html = await scorecardRes.text();
    const liveHtml = liveRes && liveRes.ok ? await liveRes.text() : "";

    if (html.length > MAX_HTML_BYTES || liveHtml.length > MAX_HTML_BYTES) {
      return res.status(502).json({ status: "error", message: "page too large to process safely" });
    }

    let scorecardRaw = splitRawChunks(html);
    let liveRaw = liveHtml ? splitRawChunks(liveHtml) : [];
    if (scorecardRaw.length > MAX_CHUNKS) scorecardRaw = scorecardRaw.slice(0, MAX_CHUNKS);
    if (liveRaw.length > MAX_CHUNKS) liveRaw = liveRaw.slice(0, MAX_CHUNKS);
    const scorecardCache = new Map();
    const liveCache = new Map();

    if (scan) {
      return res.status(200).json({
        status: "debug",
        markers_found_scorecard_page: scanAllMarkers(scorecardRaw, scorecardCache),
        markers_found_live_scores_page: scanAllMarkers(liveRaw, liveCache),
        fetch_and_split_ms: Date.now() - t0,
      });
    }

    const data = findMarkerLazy(scorecardRaw, scorecardCache, SCORECARD_MARKER);
    if (!data) {
      return res.status(502).json({
        status: "error",
        message: "could not find/parse scorecardApiData blob (match may not have started or page structure changed)",
      });
    }

    const scoreCards = data.scoreCard || [];
    if (scoreCards.length === 0) {
      return res.status(502).json({ status: "error", message: "no innings data yet" });
    }

    const current = scoreCards[scoreCards.length - 1];
    const scoreDetails = current.scoreDetails || {};
    const battingTeam = (current.batTeamDetails && current.batTeamDetails.batTeamName) || "";
    const runs = scoreDetails.runs ?? 0;
    const wickets = scoreDetails.wickets ?? 0;
    const overs = String(scoreDetails.overs ?? "not found");

    let liveBlob = null;
    for (const marker of LIVE_MARKER_CANDIDATES) {
      let d = findMarkerLazy(liveRaw, liveCache, marker);
      if (d) { liveBlob = { marker, data: d }; break; }
      d = findMarkerLazy(scorecardRaw, scorecardCache, marker);
      if (d) { liveBlob = { marker, data: d }; break; }
    }

    let batsmen = [];
    let bowlerName = "not found";
    let recent = "not found";

    if (liveBlob && (liveBlob.data.batsmanStriker || liveBlob.data.batsmanNonStriker)) {
      const bs = liveBlob.data.batsmanStriker || {};
      const bns = liveBlob.data.batsmanNonStriker || {};
      if (bs.batName) batsmen.push({ name: `${bs.batName} *`, score: `${bs.batRuns ?? 0}(${bs.batBalls ?? 0})` });
      if (bns.batName) batsmen.push({ name: bns.batName, score: `${bns.batRuns ?? 0}(${bns.batBalls ?? 0})` });
      const bwlStriker = liveBlob.data.bowlerStriker || {};
      if (bwlStriker.bowlName) bowlerName = bwlStriker.bowlName;
      if (liveBlob.data.recentOvsStats) recent = String(liveBlob.data.recentOvsStats);
    }

    let batDebug = null;
    if (batsmen.length === 0) {
      const extracted = extractBatsmen(current);
      batsmen = extracted.batsmen;
      batDebug = extracted.debugInfo;
      if (batsmen.length > 0) batsmen[0].name = `${batsmen[0].name} *`;
    }
    batsmen = batsmen.slice(0, 2);
    while (batsmen.length < 2) batsmen.push({ name: "not found", score: "not found" });

    if (bowlerName === "not found") {
      const bowlersData = (current.bowlTeamDetails && current.bowlTeamDetails.bowlersData) || {};
      let bestOvers = -1;
      let midOverBowler = null;
      for (const key of Object.keys(bowlersData)) {
        const bw = bowlersData[key];
        const ov = parseFloat(bw.overs ?? 0);
        if (!isNaN(ov) && ov % 1 !== 0) midOverBowler = bw.bowlName;
        if (!isNaN(ov) && ov > bestOvers) { bestOvers = ov; bowlerName = bw.bowlName || "not found"; }
      }
      if (midOverBowler) bowlerName = midOverBowler;
    }

    let recentHit = null;
    if (recent === "not found") {
      for (const key of RECENT_KEY_CANDIDATES) {
        let hit = findKeyLazy(scorecardRaw, scorecardCache, key, "scorecard");
        if (!hit) hit = findKeyLazy(liveRaw, liveCache, key, "live-scores");
        if (hit) { recentHit = hit; break; }
      }
      if (recentHit) {
        const v = recentHit.value;
        recent = Array.isArray(v) ? v.join(", ") : String(v).trim();
      }
    }

    const result = {
      status: "success",
      match_id: matchId,
      score: `${battingTeam} ${runs}/${wickets}`,
      overs,
      batsmen,
      bowler: bowlerName,
      recent,
    };

    if (debug) {
      result.debug = {
        innings_count: scoreCards.length,
        match_status: (data.matchHeader && data.matchHeader.status) || "unknown",
        live_blob_marker_used: liveBlob ? liveBlob.marker : null,
        current_scorecard_top_level_keys: Object.keys(current),
        batsmen_extraction_debug: batDebug,
        recent_ticker_debug: recentHit || { note: "not found — try &debug=1&scan=1" },
        total_ms: Date.now() - t0,
        fetched_at: new Date().toISOString(),
      };
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ status: "error", message: String(e) });
  }
};

function extractBatsmen(current) {
  const teamNode = current.batTeamDetails || current.battingTeamDetails || current.batTeam || current.batting || {};
  const rosterCandidates = [
    teamNode.batsmenData, teamNode.batsmenList, teamNode.batsman,
    teamNode.batters, teamNode.players, current.batsmenData,
  ];
  const roster = rosterCandidates.find((r) => r && (Array.isArray(r) ? r.length > 0 : Object.keys(r).length > 0));
  const debugInfo = { bat_team_node_keys: Object.keys(teamNode), roster_found: !!roster };
  if (!roster) return { batsmen: [], debugInfo };

  const entries = Array.isArray(roster) ? roster : Object.values(roster);
  debugInfo.roster_entry_count = entries.length;
  debugInfo.sample_raw_entry = entries[0] || null;

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
  return { batsmen: notOut, debugInfo };
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

function findMarkerLazy(rawChunks, cache, marker) {
  for (let i = 0; i < rawChunks.length; i++) {
    if (!rawChunkMayContain(rawChunks[i], marker)) continue;
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

function findKeyLazy(rawChunks, cache, key, label) {
  for (let i = 0; i < rawChunks.length; i++) {
    if (!rawChunkMayContain(rawChunks[i], key)) continue;
    const decoded = decodeChunk(rawChunks, i, cache);
    const val = extractValueAfterKey(decoded, key);
    if (val !== undefined && val !== null && String(val).length > 0) return { key, value: val, source: label };
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
    const open = c, close = c === "[" ? "]" : "}";
    let depth = 0, j = i;
    for (; j < chunk.length; j++) {
      if (chunk[j] === open) depth++;
      else if (chunk[j] === close) { depth--; if (depth === 0) { j++; break; } }
    }
    const raw = chunk.slice(i, j);
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  let j = i;
  while (j < chunk.length && !",}]".includes(chunk[j])) j++;
  return chunk.slice(i, j).trim();
}

function scanAllMarkers(rawChunks, cache) {
  const found = new Set();
  for (let i = 0; i < rawChunks.length; i++) {
    const decoded = decodeChunk(rawChunks, i, cache);
    const bounded = decoded.length > 20000 ? decoded.slice(0, 20000) : decoded;
    const matches = bounded.match(/"([a-zA-Z][a-zA-Z0-9_]{2,40})":\{/g) || [];
    for (const m of matches) found.add(m.slice(1, -2));
  }
  return Array.from(found).sort();
}
