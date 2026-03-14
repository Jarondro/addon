const axios = require("axios");
const config = require("./config");

const TMDB_BASE = "https://api.themoviedb.org/3";

// Cache to avoid hammering TMDB for the same titles
const cache = new Map();

// Language codes for TMDB
const LANG_MAP = {
    "English": "en-US",
    "Czech": "cs-CZ",
    "Slovak": "sk-SK",
};

// Strip common junk from Přehraj.to filenames
function cleanTitle(name) {
    return name
        .replace(/\.(mp4|mkv|avi|mov)$/i, "")           // remove extensions
        .replace(/\b(1080p?|720p?|480p?|4K|UHD|IMAX)\b/gi, "")  // quality tags
        .replace(/\b(WEB-DL|WEBRip|BluRay|BDRip|BRRip|HDTV|DVDRip|HDRip)\b/gi, "")
        .replace(/\b(x264|x265|H\.264|H\.265|HEVC|AVC)\b/gi, "")
        .replace(/\b(AAC|DDP?5?\.?1?|Atmos|DTS|AC3|MP3)\b/gi, "")
        .replace(/\b(CZ|SK|EN|CS|czdab|cz[-_]?dab(ing)?|sk[-_]?dab(ing)?|czech|slovak|dual)\b/gi, "")
        .replace(/\b(dabing|dab|titulky|sub|dubbed)\b/gi, "")
        .replace(/\b(FLUX|YIFY|RARBG|SPARKS|FGT|NTb)\b/gi, "")  // release groups
        .replace(/\b(NF|AMZN|DSNP|HMAX|ATVP)\b/gi, "")          // streaming tags
        .replace(/[-_.+]+/g, " ")                                  // separators to spaces
        .replace(/\s*\(?\d{4}\)?\s*$/, "")                        // trailing year
        .replace(/\s+/g, " ")
        .trim();
}

// Extract year from filename if present
function extractYear(name) {
    const match = name.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
    return match ? parseInt(match[1]) : null;
}

// Detect if it looks like a TV show (has S01E01 pattern)
function isTvShow(name) {
    return /S\d{2}E\d{2}/i.test(name);
}

// Extract season/episode
function extractEpisode(name) {
    const match = name.match(/S(\d{2})E(\d{2})/i);
    if (match) return { season: parseInt(match[1]), episode: parseInt(match[2]) };
    return null;
}

async function searchTMDB(title, year, type, language) {
    const lang = LANG_MAP[language] || "en-US";
    const endpoint = type === "series" ? "search/tv" : "search/movie";
    const cacheKey = `${title}|${year}|${type}|${lang}`;

    if (cache.has(cacheKey)) return cache.get(cacheKey);

    try {
        const params = {
            api_key: config.TMDB_API_KEY,
            query: title,
            language: lang,
            include_adult: false,
        };
        if (year) params.year = year;

        const r = await axios.get(`${TMDB_BASE}/${endpoint}`, { params });
        const results = r.data.results;

        if (!results || results.length === 0) {
            cache.set(cacheKey, null);
            return null;
        }

        const top = results[0];
        const result = {
            tmdbId: top.id,
            imdbId: null,
            title: top.title || top.name,
            originalTitle: top.original_title || top.original_name,
            year: (top.release_date || top.first_air_date || "").slice(0, 4),
            poster: top.poster_path ? `https://image.tmdb.org/t/p/w500${top.poster_path}` : null,
            backdrop: top.backdrop_path ? `https://image.tmdb.org/t/p/w1280${top.backdrop_path}` : null,
            overview: top.overview,
            rating: top.vote_average,
            type,
        };

        // Fetch IMDB ID (needed for Stremio matching)
        const detailEndpoint = type === "series" ? `tv/${top.id}` : `movie/${top.id}`;
        const detail = await axios.get(`${TMDB_BASE}/${detailEndpoint}/external_ids`, {
            params: { api_key: config.TMDB_API_KEY },
        });
        result.imdbId = detail.data.imdb_id || null;

        cache.set(cacheKey, result);
        return result;
    } catch (e) {
        console.error("[TMDB] Error:", e.message);
        cache.set(cacheKey, null);
        return null;
    }
}

async function identifyVideo(video, language = "English") {
    const name = video.name;
    const isShow = isTvShow(name);
    const type = isShow ? "series" : "movie";
    const cleaned = cleanTitle(name);
    const year = extractYear(name);
    const episode = isShow ? extractEpisode(name) : null;

    const tmdb = await searchTMDB(cleaned, year, type, language);

    return {
        ...video,
        cleanTitle: cleaned,
        type,
        year,
        episode,
        tmdb,
        imdbId: tmdb?.imdbId || null,
        displayTitle: tmdb?.title || cleaned,
        poster: tmdb?.poster || null,
        overview: tmdb?.overview || "",
        rating: tmdb?.rating || null,
    };
}

module.exports = { identifyVideo, cleanTitle, isTvShow, extractEpisode };
