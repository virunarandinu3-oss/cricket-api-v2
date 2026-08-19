// Cricbuzz eke match eke link eka methanata danna:
// ================================================================
// ================================================================
//                  MATCH LINK EKA METHANATA DANNA
// ================================================================
const MATCH_URL = "https://www.cricbuzz.com/live-cricket-scores/163013/sl-vs-ind-1st-test-india-tour-of-sri-lanka-2026";
// ================================================================
// ================================================================
//
// MEKA UPDATE EKA (v4) - monawada wenas kalේ:
// Squads part eka mulinma FULL script ekata apsu ekathu kala (score,
// toss, venue, batsmen, bowler, recent, okkoma UNCHANGED widiyata
// wada karanawa - eka mulinma thibba widiyatama). Squads eka witharak
// wenas kala:
// 1) User dunna raw HTML eken squads page eke REAL structure eka
//    confirm kala - `{"team1":{"team":{teamId,teamName,...},
//    "players":{"playing XI":[...],"bench":[...]}}, "team2":{...}}`.
//    Eka nisa "team1":{"team": kiyana fingerprint eken kelinma object
//    eka locate karagannawa (findSquadsObjectDirect) - guess/scan
//    ekak karanna one na.
// 2) Bench eka saha support staff (thiyenawa nam) EXCLUDE karala,
//    "playing XI" (or "playing"/"11"/"XI" wage keyword ekak thiyena
//    key eka) witharak players list ekata gannawa.
// 3) Player list eka nam witharak (string array ekak) - object/extra
//    fields danne na.
// 4) Direct-parse eka fail una nam (page format wenas una nam)
//    pahala fuzzy candidate-scanning eka backup widiyata thiyenawa.
// 5) `?debug=1` daalama squads_extraction_debug.method eke "direct-parse"
//    nathnam "fuzzy-fallback" kiyala penei.
//
// MEKA UPDATE EKA (v5) - alut features - PURANA DEYAK WENAS KALE NA,
// AWULAK ETHTHOTH NAWATHA add witharak kala:
// 6) Match Officials / Series info: umpire1/2/3, referee, series
//    result (e.g "Series levelled 0-0"), series start/end date.
// 7) Venue geo details: city, country, timezone, latitude, longitude.
// 8) Match Meta: matchFormat, dayNumber, dayNight, state, shortStatus,
//    livestreamEnabled + livestreamEnabledGeo list, isFantasyEnabled.
// 9) Media: highlight videos + press-conference videos (venama tag
//    karala), latest news (title+link), latest photo gallery
//    (title+link+date). Source eka: live-scores page eke JS chunk
//    ekaka thiyena "matchInfo"/"videoList"/"matchVideos" blobs, saha
//    SSR html ekema literal widiyata thiyena JSON-LD <script> tags.
//    Field ekak hamba unne nathnam "-" (NF) - "not found" text ekak
//    kisi welawaka danne na. Meka okkoma try/catch ekakin wrap karala
//    thiyenne - meka fail una athata pawa purana result eka (score,
//    batsmen, squads, etc) EKA WELAWAKATWATA break wenne na.

const SCORECARD_MARKER = "scorecardApiData";
const LIVE_MARKER_CANDIDATES = ["miniscore", "matchScoreDetails", "liveApiData", "commentaryApiData", "faceoffApiData"];
const RECENT_KEY_CANDIDATES = ["recentOvsStats", "recentOvers", "recentBalls", "recentScores", "recent"];
const SQUAD_TEAM_KEYS = ["team1", "team2"];

// squad eke Players list eka hoyaddi try karana field-name variants
// (fuzzy fallback ekata witharak - primary direct-parse eka meka
// use karanne na)
const PLAYER_LIST_KEYS = ["players", "playerList", "squad", "playing11", "playingXI", "playersList"];

const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 400;

const NF = "-"; // "not found" wenuwata methanin danna thani akura

// ---- NEW (v5) consts: news/photo link scanning ----
const NEWS_PATH_PREFIX = "/cricket-news";
const GALLERY_PATH_PREFIX = "/cricket-gallery";

function extractMatchIdFromLink(link) {
  const m = String(link).match(/cricbuzz\.com\/live-cricket-(?:scores|scorecard)\/(\d{4,20})\//);
  return m ? m[1] : null;
}

// value ekak nathnam / empty string nam / "not found" nam - "-" denawa
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
  const squadsUrl = `https://www.cricbuzz.com/cricket-match-squads/${matchId}?_cb=${cacheBuster}`;

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
    const [scorecardRes, liveRes, squadsRes] = await Promise.all([
      fetch(scorecardUrl, { headers }),
      fetch(liveScoresUrl, { headers }).catch(() => null),
      fetch(squadsUrl, { headers }).catch(() => null),
    ]);

    if (!scorecardRes.ok) {
      return res.status(502).json({ status: "error", message: "cricbuzz fetch failed: " + scorecardRes.status });
    }
    const html = await scorecardRes.text();
    const liveHtml = liveRes && liveRes.ok ? await liveRes.text() : "";
    const squadsHtml = squadsRes && squadsRes.ok ? await squadsRes.text() : "";

    if (html.length > MAX_HTML_BYTES || liveHtml.length > MAX_HTML_BYTES || squadsHtml.length > MAX_HTML_BYTES) {
      return res.status(502).json({ status: "error", message: "page too large to process safely" });
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

    if (scan) {
      return res.status(200).json({
        status: "debug",
        markers_found_scorecard_page: scanAllMarkers(scorecardRaw, scorecardCache),
        markers_found_live_scores_page: scanAllMarkers(liveRaw, liveCache),
        markers_found_squads_page: scanAllMarkers(squadsRaw, squadsCache),
        fetch_and_split_ms: Date.now() - t0,
      });
    }

    // ---- single-pass marker index eka hadanawa (CPU optimization) ----
    const scorecardNeededMarkers = [SCORECARD_MARKER, ...LIVE_MARKER_CANDIDATES, ...RECENT_KEY_CANDIDATES];
    const scorecardMarkerIndex = buildChunkMarkerIndex(scorecardRaw, scorecardNeededMarkers);

    const liveNeededMarkers = [...LIVE_MARKER_CANDIDATES, ...RECENT_KEY_CANDIDATES];
    const liveMarkerIndex = liveRaw.length ? buildChunkMarkerIndex(liveRaw, liveNeededMarkers) : new Map();

    const squadsMarkerIndex = squadsRaw.length ? buildChunkMarkerIndex(squadsRaw, SQUAD_TEAM_KEYS) : new Map();

    const data = findMarkerLazy(scorecardRaw, scorecardCache, SCORECARD_MARKER, scorecardMarkerIndex.get(SCORECARD_MARKER));
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

    let batDebug = null;
    if (batsmen.length === 0) {
      const extracted = extractBatsmen(current);
      batsmen = extracted.batsmen;
      batDebug = extracted.debugInfo;
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

    let recentHit = null;
    if (recent === NF) {
      for (const key of RECENT_KEY_CANDIDATES) {
        let hit = findKeyLazy(scorecardRaw, scorecardCache, key, "scorecard", scorecardMarkerIndex.get(key));
        if (!hit) hit = findKeyLazy(liveRaw, liveCache, key, "live-scores", liveMarkerIndex.get(key));
        if (hit) { recentHit = hit; break; }
      }
      if (recentHit) {
        const v = recentHit.value;
        recent = Array.isArray(v) ? v.join(", ") : String(v).trim();
      }
    }

    // Match / Toss / Venue — this all lives on matchHeader, which we
    // already have from the scorecard page's scorecardApiData blob.
    const matchInfo = extractMatchInfo(data.matchHeader || {});

    // ---- Squads (both teams' Team Name + Playing XI only) ----
    let squads;
    let squadsDebug;
    const directParsed = findSquadsObjectDirect(squadsRaw, squadsCache);
    if (directParsed) {
      squads = {
        team1: extractTeamNameAndPlayers(directParsed.team1),
        team2: extractTeamNameAndPlayers(directParsed.team2),
      };
      squadsDebug = {
        method: "direct-parse",
        team1_players_keys: Object.keys((directParsed.team1 && directParsed.team1.players) || {}),
        team2_players_keys: Object.keys((directParsed.team2 && directParsed.team2.players) || {}),
      };
    } else {
      // Fallback: old fuzzy candidate-scanning (in case page format changed).
      const team1Candidates = findAllMarkerObjects(squadsRaw, squadsCache, "team1", squadsMarkerIndex.get("team1"));
      const team2Candidates = findAllMarkerObjects(squadsRaw, squadsCache, "team2", squadsMarkerIndex.get("team2"));
      const fallbackTeam1 = (data.matchHeader && data.matchHeader.team1) || null;
      const fallbackTeam2 = (data.matchHeader && data.matchHeader.team2) || null;
      const extracted = extractSquadsFuzzy(team1Candidates, team2Candidates, fallbackTeam1, fallbackTeam2);
      squads = extracted.squads;
      squadsDebug = {
        method: "fuzzy-fallback",
        team1_candidates_found: team1Candidates.length,
        team2_candidates_found: team2Candidates.length,
        ...extracted.debugInfo,
      };
    }

    const result = {
      status: "success",
      match: nf(matchInfo.match),
      toss: nf(matchInfo.toss),
      venue: nf(matchInfo.venue),
      team: nf(battingTeam),
      score: `${runs}/${wickets}`,
      overs,
      batsmen: batsmen.map((b) => ({ name: nf(b.name), score: nf(b.score) })),
      bowler: nf(bowlerName),
      recent: nf(recent),
      squads,
    };

    // ================================================================
    // NEW (v5): officials, series info, venue geo, match meta, media
    // (videos/news/photos) - okkoma "matchInfo" blob eken (live-scores
    // page eke commentaryPageData ekaka thiyena) + JSON-LD <script>
    // blocks (SSR html ekema literal widiyata thiyena) eken gannawa.
    // Field ekak hamba unne nathnam "-" (NF) danawa - "not found"
    // kiyala danne na. Meka fail una athata pawa uda thiyena `result`
    // eka (score/batsmen/squads etc) ekka BADDA wenne na.
    // ================================================================
    try {
      const matchInfoBlob =
        findMarkerLazy(liveRaw, liveCache, "matchInfo", undefined) ||
        findMarkerLazy(scorecardRaw, scorecardCache, "matchInfo", undefined);

      const extended = extractExtendedMatchInfo(data.matchHeader || {}, matchInfoBlob);

      result.matchMeta = {
        format: nf(extended.meta.format),
        dayNumber: nf(extended.meta.dayNumber),
        dayNight: extended.meta.dayNight === undefined ? NF : extended.meta.dayNight,
        state: nf(extended.meta.state),
        shortStatus: nf(extended.meta.shortStatus),
        livestreamEnabled: extended.meta.livestreamEnabled === undefined ? NF : extended.meta.livestreamEnabled,
        livestreamEnabledGeo: Array.isArray(extended.meta.livestreamEnabledGeo) ? extended.meta.livestreamEnabledGeo : NF,
        isFantasyEnabled: extended.meta.isFantasyEnabled === undefined ? NF : extended.meta.isFantasyEnabled,
      };

      result.officials = {
        umpire1: nf(extended.officials.umpire1),
        umpire2: nf(extended.officials.umpire2),
        umpire3: nf(extended.officials.umpire3),
        referee: nf(extended.officials.referee),
      };

      result.series = {
        name: nf(extended.series.name),
        result: nf(extended.series.result),
        startDate: nf(extended.series.startDate),
        endDate: nf(extended.series.endDate),
      };

      result.venueDetails = {
        city: nf(extended.venueDetails.city),
        country: nf(extended.venueDetails.country),
        timezone: nf(extended.venueDetails.timezone),
        latitude: nf(extended.venueDetails.latitude),
        longitude: nf(extended.venueDetails.longitude),
      };

      // ---- JSON-LD sidebar blocks (videos/news/photos) - both pages ----
      const ldLive = extractJsonLdSidebars(liveHtml);
      const ldScorecard = extractJsonLdSidebars(html);

      // ---- videos: prefer chunk "videoList" (duration + real link
      // okkomama thiyenawa), nathnam JSON-LD VideoObject (title+
      // duration+link, videoType nathi) "matchVideos" chunk ekakin
      // enrich karanawa (Press Conference / Analysis tag ekata) ----
      let videosFinal = [];
      const videoListRaw =
        findArrayMarkerLazy(liveRaw, liveCache, "videoList", undefined) ||
        findArrayMarkerLazy(scorecardRaw, scorecardCache, "videoList", undefined);

      if (Array.isArray(videoListRaw) && videoListRaw.length > 0) {
        videosFinal = videoListRaw
          .map((entry) => entry && entry.video)
          .filter(Boolean)
          .map((v) => ({
            title: nf(v.title),
            duration: nf(v.durationStr),
            videoType: nf(v.videoType),
            link: nf(v.videoUrl),
            thumbnailId: nf(v.imageId),
            thumbnail: NF,
          }));
      } else {
        const ldVideos = ldLive.videos.length ? ldLive.videos : ldScorecard.videos;
        const matchVideosMeta = (() => {
          const a = extractMatchVideosMeta(liveRaw, liveCache);
          return a.length ? a : extractMatchVideosMeta(scorecardRaw, scorecardCache);
        })();
        videosFinal = ldVideos.map((v) => {
          const idMatch = String(v.link || "").match(/cricket-videos\/(\d+)\//);
          const meta = idMatch ? matchVideosMeta.find((mm) => String(mm.id) === idMatch[1]) : null;
          return {
            title: nf(v.title),
            duration: nf(v.duration),
            videoType: nf(meta && meta.videoType),
            link: nf(v.link),
            thumbnailId: NF,
            thumbnail: nf(v.thumbnail),
          };
        });
      }

      videosFinal = videosFinal.slice(0, 10);
      const pressConferenceVideos = videosFinal.filter((v) => String(v.videoType).toLowerCase().includes("press"));
      const highlightVideos = videosFinal.filter((v) => !String(v.videoType).toLowerCase().includes("press"));

      // ---- news (title + link; reliable timestamp source nathi nisa "-") ----
      let newsArticles = extractLinkedItems(liveHtml, NEWS_PATH_PREFIX, 8);
      if (newsArticles.length === 0) newsArticles = extractLinkedItems(html, NEWS_PATH_PREFIX, 8);
      newsArticles = newsArticles.map((n) => ({ title: nf(n.title), link: nf(n.link), date: NF }));

      // ---- photos (title + link, thibba nam JSON-LD eken date eka enrich karanawa) ----
      let photoGallery = extractLinkedItems(liveHtml, GALLERY_PATH_PREFIX, 8);
      if (photoGallery.length === 0) photoGallery = extractLinkedItems(html, GALLERY_PATH_PREFIX, 8);
      const ldPhotos = ldLive.photos.length ? ldLive.photos : ldScorecard.photos;
      photoGallery = photoGallery.map((p) => {
        const match = ldPhotos.find((lp) => lp.title === p.title);
        return { title: nf(p.title), link: nf(p.link), date: nf(match && match.date) };
      });

      result.media = {
        highlightVideos: highlightVideos.length ? highlightVideos : NF,
        pressConferenceVideos: pressConferenceVideos.length ? pressConferenceVideos : NF,
        news: newsArticles.length ? newsArticles : NF,
        photos: photoGallery.length ? photoGallery : NF,
      };

      if (debug) {
        result.debug_extra = {
          matchInfo_blob_found: !!matchInfoBlob,
          videoList_found: Array.isArray(videoListRaw) && videoListRaw.length > 0,
          videos_source: Array.isArray(videoListRaw) && videoListRaw.length > 0 ? "videoList-chunk" : "json-ld-fallback",
        };
      }
    } catch (e) {
      if (!result.matchMeta) result.matchMeta = NF;
      if (!result.officials) result.officials = NF;
      if (!result.series) result.series = NF;
      if (!result.venueDetails) result.venueDetails = NF;
      if (!result.media) result.media = NF;
      if (debug) result.debug_extra = { error: String(e) };
    }

    if (debug) {
      result.debug = {
        innings_count: scoreCards.length,
        match_status: (data.matchHeader && data.matchHeader.status) || "unknown",
        match_header_keys: Object.keys(data.matchHeader || {}),
        live_blob_marker_used: liveBlob ? liveBlob.marker : null,
        squads_extraction_debug: squadsDebug,
        current_scorecard_top_level_keys: Object.keys(current),
        batsmen_extraction_debug: batDebug,
        recent_ticker_debug: recentHit || { note: "not found — try &debug=1&scan=1" },
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

// Pulls "Match / Toss / Venue" out of matchHeader (already present in
// scorecardApiData — no extra page fetch needed for this part). Tries a
// few field-name variants defensively since Cricbuzz's exact shape can
// shift between page builds.
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

// ---------- PRIMARY squads extraction: direct-parse the known real shape ----------

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
// PURPOSELY only pulls the starting-XI array — bench / support staff
// are excluded. Looks for a key containing "playing"/"xi"/"11" first;
// skips anything that looks like "bench" or "support" along the way.
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
  // Fallback: no key obviously named "playing XI" — take the first
  // array that isn't bench/support.
  if (!playingArr) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (lower.includes("bench") || lower.includes("support")) continue;
      if (Array.isArray(playersObj[key])) { playingArr = playersObj[key]; break; }
    }
  }

  return { name, players: extractPlayerNames(playingArr || []) };
}

// team object ekaka thiyena "players" style array ekaka namas okkoma
// pluck karagannawa (string array ekak wenna puluwan, object array ekak
// wenna puluwan)
function extractPlayerNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => (typeof p === "string" ? p : (p && (p.name || p.playerName || p.fullName)) || null))
    .filter(Boolean);
}

// ---------- FALLBACK squads extraction: old fuzzy candidate-scanning ----------

// value eka array ekak nam eka ehemama denawa. Object ekak nam (e.g.
// "players": { "playing11": [...] } wage nested widiyakata una eka),
// eke athule known-key ekak try karala, nathnam thiyena loku ම array
// eka pahalata giya (depth 2ta witharak) hoyanawa.
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

// 1st: known key names try karanawa (PLAYER_LIST_KEYS) - value eka array
// ekak wenna puluwan, nathnam array ekak wraps karana object ekak wenna
// puluwan (flattenToPlayerArray eken handle karanawa).
// 2nd: eka fail una nam, team object eke thiyena property *okkoma* balala,
// name/playerName/fullName/id thiyena object tika (nathnam plain string
// tika) witharak thiyena array tika athara loku ම eka gannawa.
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

// candidates athare, players array eka loku ම thiyena object eka
// (real squad object eka) thoraganawa - just a lightweight team-name
// reference ekakata vaeradi widiyata thoranu labenna epa nisa.
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

// Pulls each team's Name + Players out of the squads page candidates
// (used ONLY if the primary direct-parse above fails to find anything).
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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- CPU optimization: single-pass multi-marker scan ----
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

// findMarkerLazy wage-mai, eth thani match ekakin nathuwa (marker ekē
// text page ekaka thana godayakin enna puluwan nisa - lightweight ref
// ekak + real object eka), hambena okkoma (maxResults dakwa) collect
// karala return karanawa. Caller ekage ithuru logic ekakin "hariyata
// thiyena" eka thoraganna puluwan (e.g. players array ekak thiyena eka).
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

function findKeyLazy(rawChunks, cache, key, label, candidateIndices) {
  const indices = candidateIndices || rawChunks.map((_, i) => i);
  for (const i of indices) {
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

// ================================================================
// NEW (v5) HELPERS - officials/series/venue/meta/media extraction
// ================================================================

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

function formatEpochDate(ms) {
  if (ms === undefined || ms === null || ms === "") return undefined;
  try {
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString().slice(0, 10);
  } catch (e) {
    return undefined;
  }
}

function extractSeriesResultText(seriesObj) {
  if (!seriesObj || typeof seriesObj !== "object") return undefined;
  return seriesObj.testSeriesResult || seriesObj.odiSeriesResult || seriesObj.t20SeriesResult || undefined;
}

// matchHeader (scorecardApiData eken) + matchInfoBlob (live-scores page
// eke commentaryPageData ekaka thiyena "matchInfo" object eka) dekakama
// check karala, field ekak koi tanaka hambunath eka gannawa.
function extractExtendedMatchInfo(matchHeader, matchInfoBlob) {
  const mh = matchHeader || {};
  const mi = matchInfoBlob || {};
  const venue = mi.venue || mh.venue || {};
  const series = mi.series || {};

  return {
    meta: {
      format: firstDefined(mh.matchFormat, mi.matchFormat),
      dayNumber: firstDefined(mi.dayNumber, mh.dayNumber),
      dayNight: firstDefined(mh.dayNight, mi.dayNight),
      state: firstDefined(mh.state, mi.state),
      shortStatus: firstDefined(mi.shortStatus, mh.shortStatus),
      livestreamEnabled: firstDefined(mh.livestreamEnabled, mi.livestreamEnabled),
      livestreamEnabledGeo: firstDefined(mi.livestreamEnabledGeo, mh.livestreamEnabledGeo),
      isFantasyEnabled: firstDefined(mi.isFantasyEnabled, mh.isFantasyEnabled),
    },
    officials: {
      umpire1: formatPersonInfo(mi.umpire1 || mh.umpire1),
      umpire2: formatPersonInfo(mi.umpire2 || mh.umpire2),
      umpire3: formatPersonInfo(mi.umpire3 || mh.umpire3),
      referee: formatPersonInfo(mi.referee || mh.referee),
    },
    series: {
      name: firstDefined(mh.seriesName, series.name),
      result: extractSeriesResultText(series),
      startDate: formatEpochDate(firstDefined(series.startDate, mh.seriesStartDt)),
      endDate: formatEpochDate(firstDefined(series.endDate, mh.seriesEndDt)),
    },
    venueDetails: {
      city: firstDefined(venue.city),
      country: firstDefined(venue.country),
      timezone: firstDefined(venue.timezone),
      latitude: firstDefined(venue.latitude),
      longitude: firstDefined(venue.longitude),
    },
  };
}

// bracket-matching version of findMarkerLazy — for top-level ARRAY values
// like "videoList":[ ... ] / "matchVideos":[ ... ] (findMarkerLazy eken
// OBJECT values ("{" walin patan gannana) witharak handle wenne).
function findArrayMarkerLazy(rawChunks, cache, marker, candidateIndices) {
  const indices = candidateIndices || rawChunks.map((_, i) => i);
  for (const i of indices) {
    const decoded = decodeChunk(rawChunks, i, cache);
    const idx = decoded.indexOf(`"${marker}":[`);
    if (idx === -1) continue;
    const bracketStart = decoded.indexOf("[", idx);
    if (bracketStart === -1) continue;
    let depth = 0, end = -1;
    for (let j = bracketStart; j < decoded.length; j++) {
      const c = decoded[j];
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    try { return JSON.parse(decoded.slice(bracketStart, end + 1)); } catch (e) { continue; }
  }
  return null;
}

// "matchVideos" array eken id + videoType + title witharak (Press
// Conference / Analysis wage tag eka) - "videoList" eke videoType
// nathi welawaka meken enrich karanna use karanawa.
function extractMatchVideosMeta(rawChunks, cache) {
  const arr = findArrayMarkerLazy(rawChunks, cache, "matchVideos", undefined);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((v) => ({ id: v && v.id, title: v && v.title, videoType: (v && v.videoType) || undefined }))
    .filter((v) => v.id);
}

// Cricbuzz SSR-karana <script type="application/ld+json"> WPSideBar
// blocks (Featured Videos / Latest News / Latest Photos okkomatama
// meke pattern ekama) - raw HTML text ekema literal widiyata thiyena
// nisa chunk-decode karanna one na, kelinma regex karanawa.
function extractJsonLdSidebars(rawHtml) {
  const out = { newsArticles: [], photos: [], videos: [] };
  if (!rawHtml) return out;
  const scriptRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = scriptRe.exec(rawHtml)) !== null) {
    let obj;
    try { obj = JSON.parse(m[1]); } catch (e) { continue; }
    if (!obj || obj["@type"] !== "WPSideBar" || !Array.isArray(obj.mainEntityOfPage)) continue;
    for (const item of obj.mainEntityOfPage) {
      if (!item || typeof item !== "object") continue;
      if (item["@type"] === "NewsArticle") {
        out.newsArticles.push({ title: item.name, image: item.image });
      } else if (item["@type"] === "ImageObject") {
        out.photos.push({ title: item.name, image: item.image, date: item.datePublished });
      } else if (item["@type"] === "VideoObject") {
        out.videos.push({
          title: item.name,
          duration: item.duration,
          link: item.contentUrl,
          thumbnail: item.thumbnailUrl,
          date: item.datePublished,
        });
      }
    }
  }
  return out;
}

// "LATEST NEWS" / "LATEST PHOTOS" widiyata thiyena links - anchor href
// eka + langama thiyena "mb-2.5" title div eka regex ekakin pair
// karanawa (raw SSR html ekema thiyena nisa chunk-decode one na).
function extractLinkedItems(rawHtml, pathPrefix, maxResults) {
  maxResults = maxResults || 8;
  const items = [];
  if (!rawHtml) return items;
  const re = new RegExp('href="(' + escapeRegex(pathPrefix) + '\\/[^"]+)"[^>]*>[\\s\\S]{0,2000}?class="mb-2\\.5">([^<]{2,200})<', "g");
  let m;
  const seen = new Set();
  while ((m = re.exec(rawHtml)) !== null && items.length < maxResults) {
    const link = m[1];
    const title = m[2].trim();
    if (seen.has(link) || !title) continue;
    seen.add(link);
    items.push({ title, link: "https://www.cricbuzz.com" + link });
  }
  return items;
}
