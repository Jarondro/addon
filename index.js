const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const prehraj = require("./prehraj");
const { identifyVideo } = require("./tmdb");
const config = require("./config");

const LANG_PRIORITY = {
    "Czech":   ["cz", "czech", "czdab", "cz-dab", "cz dabing", "česky", "cesky"],
    "Slovak":  ["sk", "slovak", "skdab", "sk-dab", "sk dabing", "slovensky"],
    "English": ["en", "english"],
};

// Quality ordering — higher = better
const QUALITY_ORDER = ["2160", "4k", "4K", "1080", "720", "480"];

function getBestStream(links) {
    for (const q of QUALITY_ORDER) {
        if (links[q]) return { quality: q === "4k" || q === "4K" ? "2160" : q, url: links[q] };
    }
    // Fallback: pick highest numeric key
    const entries = Object.entries(links);
    if (entries.length === 0) return null;
    entries.sort((a, b) => parseInt(b[0]) - parseInt(a[0]));
    return { quality: entries[0][0], url: entries[0][1] };
}

function formatSize(bytes) {
    const gb = parseInt(bytes) / 1e9;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(parseInt(bytes) / 1e6).toFixed(0)} MB`;
}

function formatQuality(q) {
    if (q === "2160" || q === "4k" || q === "4K") return "4K";
    return `${q}p`;
}

function getLangLabel(name) {
    const lower = name.toLowerCase();
    if (LANG_PRIORITY["Czech"].some(k => lower.includes(k))) return "🇨🇿";
    if (LANG_PRIORITY["Slovak"].some(k => lower.includes(k))) return "🇸🇰";
    if (LANG_PRIORITY["English"].some(k => lower.includes(k))) return "🇬🇧";
    // Detect by Czech/Slovak characters in the title itself
    if (/[áéíóúýčšžřůěďťň]/i.test(name)) return "🇨🇿";
    return "";
}

function sortByLikes(videos) {
    return [...videos].sort((a, b) => {
        const likesA = (a.thumbs && a.thumbs.global && a.thumbs.global.up) || 0;
        const likesB = (b.thumbs && b.thumbs.global && b.thumbs.global.up) || 0;
        return likesB - likesA;
    });
}

async function getTitles(imdbId, tmdbItem, type) {
    // Returns { english, czech }
    const english = tmdbItem.title || tmdbItem.name || tmdbItem.original_title || tmdbItem.original_name;
    let czech = null;
    try {
        const tmdbType = type === "series" ? "tv" : "movie";
        const r = await axios.get(`https://api.themoviedb.org/3/${tmdbType}/${tmdbItem.id}`, {
            params: { api_key: config.TMDB_API_KEY, language: "cs-CZ" },
        });
        const loc = r.data.title || r.data.name;
        if (loc && loc !== english) czech = loc;
    } catch(e) {}
    return { english, czech };
}

async function searchVideos(query, episodeInfo) {
    const results = await prehraj.search(query);
    let videos = results.data || [];
    if (episodeInfo) {
        const s = String(episodeInfo.season).padStart(2, "0");
        const e = String(episodeInfo.episode).padStart(2, "0");
        const pat = new RegExp(`S${s}E${e}`, "i");
        const filtered = videos.filter(v => pat.test(v.name));
        if (filtered.length > 0) videos = filtered;
    }
    return videos;
}

function buildAddon() {
    const manifest = {
        id: "community.prehrajto",
        version: "1.0.0",
        name: "Přehraj.to",
        description: "Doplnok pre streamovanie obsahu z Prehraj.to",
        logo: "https://prehraj.to/favicon-96x96.png",
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt"],
        catalogs: [
            {
                type: "movie",
                id: "prehrajto-movies",
                name: "Přehraj.to Movies",
                extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
            },
            {
                type: "series",
                id: "prehrajto-series",
                name: "Přehraj.to Series",
                extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
            },
        ],
    };

    const builder = new addonBuilder(manifest);

    // ── CATALOG ──────────────────────────────────────────────────────────────
    builder.defineCatalogHandler(async ({ type, extra }) => {
        const search = extra && extra.search;
        const skip = parseInt((extra && extra.skip) || 0);
        const page = Math.floor(skip / 32) + 1;
        console.log(`[Catalog] type=${type} search="${search}" page=${page}`);

        try {
            let results;
            if (search) {
                results = await prehraj.search(search, page);
            } else {
                results = await prehraj.getMostWatched();
            }

            const videos = results.data || [];
            const filtered = videos.filter(v => {
                const isShow = /S\d{2}E\d{2}/i.test(v.name);
                return type === "series" ? isShow : !isShow;
            });

            const identified = await Promise.all(
                filtered.slice(0, 20).map(v => identifyVideo(v, "Czech").catch(() => ({
                    ...v, cleanTitle: v.name, type, imdbId: null,
                    displayTitle: v.name, poster: v.thumbnails && v.thumbnails[0] || null, overview: "",
                })))
            );

            const seen = new Set();
            const metas = identified
                .filter(v => v.imdbId && !seen.has(v.imdbId) && seen.add(v.imdbId))
                .map(v => ({
                    id: v.imdbId,
                    type,
                    name: v.displayTitle,
                    poster: v.poster || (v.thumbnails && v.thumbnails[0]),
                    posterShape: "poster",
                    background: v.tmdb && v.tmdb.backdrop || null,
                    description: v.overview,
                    imdbRating: v.rating ? v.rating.toFixed(1) : undefined,
                    year: v.year ? parseInt(v.year) : undefined,
                }));

            return { metas };
        } catch (e) {
            console.error("[Catalog] Error:", e.message);
            return { metas: [] };
        }
    });

    // ── META ─────────────────────────────────────────────────────────────────
    builder.defineMetaHandler(async ({ type, id }) => {
        console.log(`[Meta] type=${type} id=${id}`);
        return { meta: null };
    });

    // ── STREAMS ──────────────────────────────────────────────────────────────
    builder.defineStreamHandler(async ({ type, id }) => {
        console.log(`[Streams] type=${type} id=${id}`);

        try {
            const parts = id.split(":");
            const imdbId = parts[0];
            let episodeInfo = null;
            if (type === "series" && parts.length === 3) {
                episodeInfo = { season: parseInt(parts[1]), episode: parseInt(parts[2]) };
            }

            // Look up TMDB
            const findR = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                params: { api_key: config.TMDB_API_KEY, external_source: "imdb_id" },
            });

            const tmdbItem = type === "series"
                ? findR.data.tv_results && findR.data.tv_results[0]
                : findR.data.movie_results && findR.data.movie_results[0];

            if (!tmdbItem) {
                console.log(`[Streams] No TMDB match for ${imdbId}`);
                return { streams: [] };
            }

            const { english: englishTitle, czech: czechTitle } = await getTitles(imdbId, tmdbItem, type);
            console.log(`[Streams] Titles — EN: "${englishTitle}" CZ: "${czechTitle || "none"}"`);

            // Build search queries with episode suffix
            function withEp(title) {
                if (!episodeInfo) return title;
                const s = String(episodeInfo.season).padStart(2, "0");
                const e = String(episodeInfo.episode).padStart(2, "0");
                return `${title} S${s}E${e}`;
            }

            // Search strategy:
            // 1. Czech title
            // 2. English title
            // 3. Czech title fallback (without ep suffix, broader)
            let allVideos = [];

            if (czechTitle) {
                console.log(`[Streams] Searching CZ: "${withEp(czechTitle)}"`);
                const czVideos = await searchVideos(withEp(czechTitle), episodeInfo);
                allVideos.push(...czVideos);
            }

            console.log(`[Streams] Searching EN: "${withEp(englishTitle)}"`);
            const enVideos = await searchVideos(withEp(englishTitle), episodeInfo);
            // Add EN results that aren't already in list
            const seenIds = new Set(allVideos.map(v => v.id));
            for (const v of enVideos) {
                if (!seenIds.has(v.id)) { allVideos.push(v); seenIds.add(v.id); }
            }

            // Fallback searches when CZ + EN both return nothing
            if (allVideos.length === 0 && czechTitle) {
                // Split on any colon or dash variant (unicode-safe)
                const splitRe = /[:\u2013\u2014\u2012-]/;
                const enMain = englishTitle.split(splitRe)[0].trim();
                const czParts = czechTitle.split(splitRe);
                const czSub = czParts[czParts.length - 1].trim();

                console.log(`[Streams] Fallback — enMain: "${enMain}" czSub: "${czSub}"`);

                // Try: EN main + CZ subtitle e.g. "South Park: Návrat Covidu"
                if (enMain && czSub && enMain !== czSub) {
                    const hybrid = withEp(`${enMain}: ${czSub}`);
                    console.log(`[Streams] Fallback 1 hybrid: "${hybrid}"`);
                    const fallback = await searchVideos(hybrid, episodeInfo);
                    for (const v of fallback) {
                        if (!seenIds.has(v.id)) { allVideos.push(v); seenIds.add(v.id); }
                    }
                }

                // Try: just the CZ subtitle alone e.g. "Návrat Covidu"
                if (allVideos.length === 0 && czSub && czSub !== czechTitle) {
                    console.log(`[Streams] Fallback 2 CZ sub: "${withEp(czSub)}"`);
                    const fallback = await searchVideos(withEp(czSub), episodeInfo);
                    allVideos.push(...fallback);
                }

                // Try: just EN subtitle e.g. "The Return of COVID"
                if (allVideos.length === 0) {
                    const enParts = englishTitle.split(splitRe);
                    const enSub = enParts[enParts.length - 1].trim();
                    if (enSub && enSub !== englishTitle) {
                        console.log(`[Streams] Fallback 3 EN sub: "${withEp(enSub)}"`);
                        const fallback = await searchVideos(withEp(enSub), episodeInfo);
                        allVideos.push(...fallback);
                    }
                }
            }

            if (allVideos.length === 0) {
                console.log("[Streams] No results found");
                return { streams: [] };
            }

            // Sort by likes (most liked first)
            const sorted = sortByLikes(allVideos);
            const streams = [];

            for (const video of sorted.slice(0, 15)) {
                try {
                    const detail = await prehraj.getVideo(video.id);
                    const links = detail.links || {};
                    const best = getBestStream(links);
                    if (!best) continue;

                    const qualLabel = formatQuality(best.quality);
                    const likes = (video.thumbs && video.thumbs.global && video.thumbs.global.up) || 0;
                    const sizeStr = formatSize(video.size);
                    // If original is 4K but links only go to 1080, note the source resolution
                    const is4kSource = detail.originalWidth >= 3840;
                    const displayQual = (is4kSource && best.quality !== "2160")
                        ? `${qualLabel} (4K src)`
                        : qualLabel;

                    const stream = {
                        url: best.url,
                        name: `Přehraj.to ${displayQual}`,
                        description: `${video.name}\n👍 ${likes}  📀 ${sizeStr}  ${getLangLabel(video.name)}`,
                        behaviorHints: { notWebReady: false },
                    };

                    if (detail.subtitles && detail.subtitles.length > 0) {
                        stream.subtitles = detail.subtitles.map(s => ({
                            id: String(s.id),
                            url: s.cdnUrl,
                            lang: s.language || s.name,
                        }));
                    }

                    streams.push(stream);
                } catch (e) {
                    console.error(`[Streams] Failed to get video ${video.id}:`, e.message);
                }
            }

            console.log(`[Streams] Returning ${streams.length} streams`);
            return { streams };
        } catch (e) {
            console.error("[Streams] Error:", e.message);
            return { streams: [] };
        }
    });

    return builder.getInterface();
}

// ── SERVER ────────────────────────────────────────────────────────────────────
const app = express();
const router = getRouter(buildAddon());
app.use("/", router);

app.listen(config.PORT, () => {
    console.log(`\n✅ Přehraj.to Stremio addon running!`);
    console.log(`📺 Install in Stremio: http://127.0.0.1:${config.PORT}/manifest.json\n`);
});
