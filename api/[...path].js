const axios = require("axios");
const cheerio = require("cheerio");

const TORBOX_API_KEY = process.env.TORBOX_API_KEY || "dfdedcf5-b06e-4668-8188-ffd1fb9556dc";
const OMDB_API_KEY   = process.env.OMDB_API_KEY   || "91fa16b4";
const SKT_UID        = process.env.SKT_UID        || "909010";
const SKT_PASS       = process.env.SKT_PASS       || "875b64631dbcc07284d9ae5c81423669";

const TORBOX_BASE    = "https://api.torbox.app/v1/api";
const SKT_BASE       = "https://sktorrent.eu/torrent";

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
].map(t => `&tr=${encodeURIComponent(t)}`).join("");

const MANIFEST = {
    id: "org.stremio.sktorrent-torbox",
    version: "3.0.0",
    name: "SKTorrent + Torbox",
    description: "Streamování přes Torbox z torrentů nalezených na sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

// ============================================================
// OMDb
// ============================================================
async function getMediaInfo(imdbId) {
    try {
        const { data } = await axios.get(
            `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`,
            { timeout: 10000 }
        );
        if (!data || data.Response === "False") return null;
        return { title: data.Title, year: data.Year, type: data.Type };
    } catch (err) {
        console.error("OMDb chyba:", err.message);
        return null;
    }
}

// ============================================================
// SKTorrent scraping
// ============================================================
async function scrapeTorrents(searchQuery) {
    try {
        const url = `${SKT_BASE}/torrents_v2.php?search=${encodeURIComponent(searchQuery)}&active=0`;
        console.log("Scraping:", url);

        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "cs-CZ,cs;q=0.9",
            "Referer": `${SKT_BASE}/`,
            "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`
        };

        const { data } = await axios.get(url, { headers, timeout: 20000 });
        const $ = cheerio.load(data);
        const results = [];

        $("table tr").each((_, el) => {
            const row = $(el);

            // Skutečné torrenty mají v details.php odkazu parametr "name="
            // Komentáře mají pouze "id=" s "#comments" na konci - ty přeskočíme
            const detailLink = row.find("a[href*='details.php?name=']");
            if (!detailLink.length) return;

            // Vezmi první řádek titulu (před \n)
            const fullTitle = detailLink.first().text().trim();
            const title     = fullTitle.split("\n")[0].trim();
            if (!title || title.length < 3) return;

            const detHref = detailLink.first().attr("href") || "";

            // Hash je vždy v details.php?name=...&id=HASH
            const hashMatch = detHref.match(/[?&]id=([a-fA-F0-9]{40})/i);
            if (!hashMatch) return;

            const infoHash = hashMatch[1].toLowerCase();

            let size = "";
            let seeders = 0;
            row.find("td").each((_, td) => {
                const text = $(td).text().trim();
                if (/\d+(\.\d+)?\s*(MB|GB|MiB|GiB)/i.test(text)) size = text;
                if (/^\d{1,5}$/.test(text)) {
                    const n = parseInt(text);
                    if (n > seeders && n < 50000) seeders = n;
                }
            });

            results.push({ title, infoHash, size, seeders });
        });

        results.sort((a, b) => b.seeders - a.seeders);
        console.log(`Nalezeno ${results.length} torrentů pro "${searchQuery}"`);
        return results;
    } catch (err) {
        console.error("Scraping chyba:", err.message);
        return [];
    }
}

// ============================================================
// Torbox
// ============================================================
async function findExistingTorrent(infoHash) {
    try {
        const { data } = await axios.get(`${TORBOX_BASE}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: { bypass_cache: true },
            timeout: 15000
        });
        const list = data?.data || [];
        return list.find(t => t.hash?.toLowerCase() === infoHash) || null;
    } catch (err) {
        console.error("Torbox mylist chyba:", err.message);
        return null;
    }
}

async function addMagnetToTorbox(infoHash, name) {
    const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || "")}${TRACKERS}`;
    try {
        const { data } = await axios.post(
            `${TORBOX_BASE}/torrents/createtorrent`,
            { magnet, seed: 1, allow_zip: false },
            {
                headers: {
                    Authorization: `Bearer ${TORBOX_API_KEY}`,
                    "Content-Type": "application/json"
                },
                timeout: 15000
            }
        );
        if (data?.detail?.torrent_id) return data.detail.torrent_id;
        return data?.data?.torrent_id || null;
    } catch (err) {
        console.error("Torbox addMagnet chyba:", err.message);
        return null;
    }
}

async function getTorboxStreamUrl(torrentId) {
    try {
        const infoRes = await axios.get(`${TORBOX_BASE}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: { id: torrentId, bypass_cache: true },
            timeout: 15000
        });

        const torrent = infoRes.data?.data;
        if (!torrent) return null;

        const state    = (torrent.download_state || torrent.status || "unknown").toLowerCase();
        const progress = torrent.progress || 0;
        console.log(`Torrent ${torrentId}: stav="${state}", progress=${progress}%`);

        const streamableStates = ["completed", "seeding", "cached", "downloading"];
        const isReady = streamableStates.some(s => state.includes(s));
        if (!isReady) return { url: null, state, progress };

        const files = torrent.files || [];
        if (!files.length) return null;

        const videoExt   = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts)$/i;
        const videoFiles = files.filter(f => videoExt.test(f.name || ""));
        const candidates = videoFiles.length > 0 ? videoFiles : files;
        const biggest    = candidates.reduce((a, b) => (a.size > b.size ? a : b));

        const linkRes = await axios.get(`${TORBOX_BASE}/torrents/requestdl`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: {
                token: TORBOX_API_KEY,
                torrent_id: torrentId,
                file_id: biggest.id,
                zip_link: false
            },
            timeout: 15000
        });

        const streamUrl = linkRes.data?.data;
        return streamUrl ? { url: streamUrl, state: "ready" } : null;
    } catch (err) {
        console.error("getTorboxStreamUrl chyba:", err.message);
        return null;
    }
}

async function resolveViaTorbox(torrent) {
    const { infoHash, title, size, seeders } = torrent;

    let torrentId = null;
    const existing = await findExistingTorrent(infoHash);
    if (existing) {
        torrentId = existing.id;
    } else {
        torrentId = await addMagnetToTorbox(infoHash, title);
    }

    if (!torrentId) return null;

    const result = await getTorboxStreamUrl(torrentId);
    if (!result) return null;

    const meta = [size, seeders ? `🌱 ${seeders}` : ""].filter(Boolean).join(" | ");

    if (result.state !== "ready") {
        return {
            name: `⏳ Torbox ${Math.round(result.progress || 0)}%`,
            title: `${title}\n${meta}\nStav: ${result.state}`,
            externalUrl: "https://torbox.app/dashboard",
            behaviorHints: { notWebReady: true }
        };
    }

    return {
        name: "▶ Torbox",
        title: `${title}\n${meta}`,
        url: result.url,
        behaviorHints: { notWebReady: false }
    };
}

// ============================================================
// Hlavní handler – rozhoduje podle URL
// ============================================================
module.exports = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") return res.status(200).end();

    const path = req.url.split("?")[0].replace(/^\/api\/\[\.\.\.path\]/, "");
    console.log("Request path:", path);

    // Manifest
    if (path === "" || path === "/" || path.includes("manifest")) {
        return res.json(MANIFEST);
    }

    // Stream: /stream/movie/tt1234567.json
    const streamMatch = path.match(/\/stream\/([^/]+)\/(.+?)(?:\.json)?$/);
    if (streamMatch) {
        const type    = streamMatch[1];
        const fullId  = streamMatch[2];
        const parts   = fullId.split(":");
        const imdbId  = parts[0];
        const season  = parts[1] ? parseInt(parts[1]) : null;
        const episode = parts[2] ? parseInt(parts[2]) : null;

        console.log(`Stream: type=${type} id=${fullId}`);

        const mediaInfo = await getMediaInfo(imdbId);
        if (!mediaInfo?.title) return res.json({ streams: [] });

        console.log(`Titul: ${mediaInfo.title} (${mediaInfo.type}, ${mediaInfo.year})`);

        let searchQuery = mediaInfo.title;
        if (mediaInfo.type === "series" && season && episode) {
            const s = String(season).padStart(2, "0");
            const e = String(episode).padStart(2, "0");
            searchQuery = `${mediaInfo.title} S${s}E${e}`;
        } else if (mediaInfo.year) {
            searchQuery = `${mediaInfo.title} ${mediaInfo.year}`;
        }

        console.log(`Hledám: "${searchQuery}"`);

        let torrents = await scrapeTorrents(searchQuery);
        if (!torrents.length && season && episode) {
            torrents = await scrapeTorrents(mediaInfo.title);
        }

        if (!torrents.length) return res.json({ streams: [] });

        const top     = torrents.slice(0, 5);
        const results = await Promise.all(top.map(t => resolveViaTorbox(t)));
        const streams = results.filter(Boolean);

        console.log(`Vráceno ${streams.length} streamů`);
        return res.json({ streams });
    }

    return res.status(404).json({ error: "Not found" });
};
