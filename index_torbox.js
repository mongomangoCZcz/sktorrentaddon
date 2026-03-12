const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// ============================================================
// KONFIGURACE – vyplň svůj Torbox API klíč
// ============================================================
const TORBOX_API_KEY = process.env.TORBOX_API_KEY || "TVUJ_TORBOX_API_KLIC";
const OMDB_API_KEY   = process.env.OMDB_API_KEY   || "91fa16b4";
const PORT           = process.env.PORT            || 3000;

const TORBOX_BASE    = "https://api.torbox.app/v1/api";

// ============================================================
// Manifest
// ============================================================
const manifest = {
    id: "org.stremio.sktorrent-torbox",
    version: "2.0.0",
    name: "SKTorrent + Torbox",
    description: "Streamování přes Torbox z torrentů nalezených na sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

// ============================================================
// OMDb – název podle IMDb ID
// ============================================================
async function getMovieTitle(imdbId) {
    try {
        const { data } = await axios.get(
            `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`
        );
        return data.Title || null;
    } catch (err) {
        console.error("OMDb chyba:", err.message);
        return null;
    }
}

// ============================================================
// SKTorrent – scraping magnetů
// ============================================================
async function scrapeTorrents(movieTitle) {
    try {
        const url = `https://sktorrent.eu/torrents_v2.php?search=${encodeURIComponent(movieTitle)}&active=0`;
        const { data } = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml"
            },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        const results = [];

        $("table.lista tr").has("td.lista").each((_, el) => {
            const downloadLink = $(el).find("a[href^='download.php']").attr("href");
            const title        = $(el).find("a[href^='details.php']").text().trim();
            const category     = $(el).find("td.lista a[href^='torrents.php?category=']").text().trim();
            const size         = $(el).find("td.lista").eq(4).text().trim();
            const seeders      = parseInt($(el).find("td.lista").eq(5).text().trim()) || 0;

            if (!downloadLink) return;

            const hashMatch = downloadLink.match(/id=([a-fA-F0-9]{40})/i);
            if (!hashMatch) return;

            const infoHash = hashMatch[1].toLowerCase();
            const isMedia  = /Filmy|Seriál|TV\s*Pořad/i.test(category);
            if (!isMedia) return;

            results.push({ title, infoHash, size, seeders, category });
        });

        // Seřaď podle seedů – nejlepší první
        results.sort((a, b) => b.seeders - a.seeders);
        return results;
    } catch (err) {
        console.error("Scraping chyba:", err.message);
        return [];
    }
}

// ============================================================
// Torbox – přidej torrent a získej stream URL
// ============================================================

/**
 * Zkusí najít existující torrent v Torbox fronty.
 * Vrátí torrent objekt nebo null.
 */
async function findExistingTorrent(infoHash) {
    try {
        const { data } = await axios.get(`${TORBOX_BASE}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: { bypass_cache: true }
        });
        const list = data?.data || [];
        return list.find(t => t.hash?.toLowerCase() === infoHash) || null;
    } catch (err) {
        console.error("Torbox mylist chyba:", err.message);
        return null;
    }
}

/**
 * Přidá magnet do Torboxu a vrátí torrent_id.
 */
async function addMagnetToTorbox(infoHash) {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    try {
        const { data } = await axios.post(
            `${TORBOX_BASE}/torrents/createtorrent`,
            { magnet, seed: 1, allow_zip: false },
            { headers: { Authorization: `Bearer ${TORBOX_API_KEY}` } }
        );
        return data?.data?.torrent_id || null;
    } catch (err) {
        console.error("Torbox addMagnet chyba:", err.message);
        return null;
    }
}

/**
 * Získá přímý HTTP stream link z Torboxu pro daný torrent_id.
 * Vybere největší soubor (obvykle video).
 */
async function getTorboxStreamUrl(torrentId) {
    try {
        // Získej info o torrentu
        const infoRes = await axios.get(`${TORBOX_BASE}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: { id: torrentId, bypass_cache: true }
        });

        const torrent = infoRes.data?.data;
        if (!torrent) return null;

        // Pokud torrent není hotový, vrátíme null
        // (Stremio plugin nemůže čekat na stahování – uživatel to zkusí znovu)
        if (torrent.download_state !== "completed" && torrent.download_state !== "seeding") {
            console.log(`Torrent ${torrentId} stav: ${torrent.download_state} (${torrent.progress}%)`);
            return { url: null, state: torrent.download_state, progress: torrent.progress };
        }

        // Najdi největší soubor
        const files = torrent.files || [];
        if (!files.length) return null;

        const videoExtensions = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;
        const videoFiles = files.filter(f => videoExtensions.test(f.name));
        const targetFiles = videoFiles.length > 0 ? videoFiles : files;
        const biggestFile = targetFiles.reduce((a, b) => (a.size > b.size ? a : b));

        // Požádej o přímý link
        const linkRes = await axios.get(`${TORBOX_BASE}/torrents/requestdl`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: {
                token: TORBOX_API_KEY,
                torrent_id: torrentId,
                file_id: biggestFile.id,
                zip_link: false
            }
        });

        const streamUrl = linkRes.data?.data;
        return streamUrl ? { url: streamUrl, state: "ready" } : null;
    } catch (err) {
        console.error("Torbox getStreamUrl chyba:", err.message);
        return null;
    }
}

/**
 * Hlavní funkce: vezme infoHash, přidá do Torboxu, vrátí stream info.
 */
async function resolveViaTorbox(torrent) {
    const { infoHash, title, size, seeders } = torrent;

    // 1. Zkontroluj jestli torrent už v Torboxu existuje
    let existing = await findExistingTorrent(infoHash);
    let torrentId;

    if (existing) {
        torrentId = existing.id;
        console.log(`Torbox: torrent nalezen (id=${torrentId}, stav=${existing.download_state})`);
    } else {
        // 2. Přidej magnet do Torboxu
        torrentId = await addMagnetToTorbox(infoHash);
        if (!torrentId) return null;
        console.log(`Torbox: magnet přidán (id=${torrentId})`);
    }

    // 3. Zkus získat stream URL
    const result = await getTorboxStreamUrl(torrentId);
    if (!result) return null;

    if (result.state !== "ready") {
        // Vrátíme stream s popiskem stavu – Stremio ho zobrazí, ale přehrát nepůjde
        // (Torbox teprve stahuje/seeduje)
        return {
            name: `⏳ Torbox [${result.progress || 0}%]`,
            title: `${title}\n${size} | 🌱 ${seeders} | Stav: ${result.state}`,
            // Fake URL – uživatel vidí info, že stahování probíhá
            externalUrl: `https://torbox.app/dashboard`
        };
    }

    return {
        name: `▶ Torbox`,
        title: `${title}\n${size} | 🌱 ${seeders}`,
        url: result.url,
        behaviorHints: { notWebReady: false }
    };
}

// ============================================================
// Stremio – stream handler
// ============================================================
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    const imdbId = args.id;
    console.log(`\n=== Stream request: ${imdbId} ===`);

    // 1. Název z OMDb
    const movieTitle = await getMovieTitle(imdbId);
    if (!movieTitle) {
        console.log("Název nenalezen.");
        return { streams: [] };
    }
    console.log(`Název: ${movieTitle}`);

    // 2. Torrenty ze SKTorrent
    const torrents = await scrapeTorrents(movieTitle);
    if (!torrents.length) {
        console.log("Žádné torrenty nenalezeny.");
        return { streams: [] };
    }
    console.log(`Nalezeno ${torrents.length} torrentů.`);

    // 3. Zpracuj prvních N torrentů přes Torbox (paralelně, max 5)
    const TOP_N = 5;
    const top = torrents.slice(0, TOP_N);

    const streamResults = await Promise.all(top.map(t => resolveViaTorbox(t)));
    const streams = streamResults.filter(Boolean);

    console.log(`Vráceno ${streams.length} streamů.`);
    return { streams };
});

// ============================================================
// Start
// ============================================================
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅ SKTorrent+Torbox addon běží na http://127.0.0.1:${PORT}/manifest.json\n`);
