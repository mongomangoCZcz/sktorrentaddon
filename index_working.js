const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// ============================================================
// KONFIGURACE
// ============================================================
const TORBOX_API_KEY  = process.env.TORBOX_API_KEY  || "dfdedcf5-b06e-4668-8188-ffd1fb9556dc";
const OMDB_API_KEY    = process.env.OMDB_API_KEY    || "91fa16b4";
const SKT_UID         = process.env.SKT_UID         || "909010";   // <-- tvoje UID z cookie sktorrent.eu
const SKT_PASS        = process.env.SKT_PASS        || "875b64631dbcc07284d9ae5c81423669";   // <-- tvůj pass z cookie sktorrent.eu
const PORT            = process.env.PORT            || 3000;

const TORBOX_BASE     = "https://api.torbox.app/v1/api";
// Správná base URL pro sktorrent.eu (podsložka /torrent/)
const SKT_BASE        = "https://sktorrent.eu/torrent";

// Trackers pro magnet link
const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://explodie.org:6969/announce"
].map(t => `&tr=${encodeURIComponent(t)}`).join("");

// ============================================================
// Manifest
// ============================================================
const manifest = {
    id: "org.stremio.sktorrent-torbox",
    version: "3.1.0",
    name: "SKTorrent + Torbox",
    description: "Streamování přes Torbox z torrentů nalezených na sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

// ============================================================
// OMDb – název + rok + typ podle IMDb ID
// ============================================================
async function getMediaInfo(imdbId) {
    try {
        const { data } = await axios.get(
            `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`
        );
        if (!data || data.Response === "False") return null;
        return {
            title: data.Title || null,
            year:  data.Year  || null,
            type:  data.Type  || "movie"  // "movie" nebo "series"
        };
    } catch (err) {
        console.error("OMDb chyba:", err.message);
        return null;
    }
}

// ============================================================
// SKTorrent – scraping
// Stremio předává:
//   - pro filmy:   args.id = "tt1234567"
//   - pro seriály: args.id = "tt1234567:1:2"  (imdb:season:episode)
// ============================================================
async function scrapeTorrents(searchQuery) {
    try {
        // Správná URL včetně /torrent/ cesty
        const url = `${SKT_BASE}/torrents_v2.php?search=${encodeURIComponent(searchQuery)}&active=0`;
        console.log(`Hledám na: ${url}`);

        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "cs-CZ,cs;q=0.9,sk;q=0.8",
            "Referer": `${SKT_BASE}/`,
        };

        // Přidej cookies pro přihlášení, pokud jsou nastavené
        if (SKT_UID && SKT_PASS) {
            headers["Cookie"] = `uid=${SKT_UID}; pass=${SKT_PASS}`;
        }

        const { data } = await axios.get(url, { headers, timeout: 20000 });

        const $ = cheerio.load(data);
        const results = [];

        // Ladění: loguj část HTML pro kontrolu struktury
        // console.log("HTML snippet:", $.html().substring(0, 2000));

        // SKTorrent používá různé struktury – zkusíme více selektorů
        // Primární: řádky tabulky s třídou "lista" nebo "lista2"
        const rows = $("table tr").filter((_, el) => {
            const cls = $(el).attr("class") || "";
            return cls.includes("lista") || cls.includes("odd") || cls.includes("even");
        });

        console.log(`Nalezeno řádků v tabulce: ${rows.length}`);

        rows.each((_, el) => {
            const row = $(el);

            // Pokus 1: odkaz na download s parametrem id= (hash torrentu)
            let infoHash = null;
            let torrentFileUrl = null;
            let title = "";

            // Hledej odkaz na details nebo download
            const detailLink = row.find("a[href*='details.php']");
            const dlLink = row.find("a[href*='download.php']");

            if (detailLink.length) {
                title = detailLink.text().trim();
                // Hash může být v odkazu details nebo download
                const detailHref = detailLink.attr("href") || "";
                const dlHref = dlLink.attr("href") || "";

                // Extrahuj hash z id= parametru
                const hashFromDl = dlHref.match(/[?&]id=([a-fA-F0-9]{40})/i);
                const hashFromDetail = detailHref.match(/[?&]id=([a-fA-F0-9]{40})/i);

                if (hashFromDl) {
                    infoHash = hashFromDl[1].toLowerCase();
                    torrentFileUrl = `${SKT_BASE}/${dlHref.replace(/^\/torrent\//, "").replace(/^torrent\//, "")}`;
                } else if (hashFromDetail) {
                    infoHash = hashFromDetail[1].toLowerCase();
                }

                // Pokud hash není v URL, zkus ho najít z číselného ID a přeskočit
                if (!infoHash) {
                    // Zkus číselné ID v download linku
                    const numId = dlHref.match(/[?&]id=(\d+)/i);
                    if (numId && dlLink.length) {
                        // Uložíme URL torrent souboru pro pozdější stažení
                        torrentFileUrl = `${SKT_BASE}/${dlHref.startsWith("/") ? dlHref.substring(1) : dlHref}`;
                    }
                }
            }

            // Pokud nemáme ani hash ani URL, přeskočíme
            if (!infoHash && !torrentFileUrl) return;

            // Kategorie – filtruj jen media
            const cells = row.find("td");
            let category = "";
            let size = "";
            let seeders = 0;

            cells.each((i, cell) => {
                const text = $(cell).text().trim();
                if ($(cell).find("a[href*='category']").length) {
                    category = $(cell).find("a[href*='category']").first().text().trim();
                }
                // Heuristika: najdi buňku s velikostí (obsahuje MB nebo GB)
                if (/\d+(\.\d+)?\s*(MB|GB|KB|GiB|MiB)/i.test(text)) {
                    size = text;
                }
            });

            // Seedy – hledáme čísla
            const seedCell = row.find("td.lista").last();
            const seedText = seedCell.text().trim();
            if (/^\d+$/.test(seedText)) {
                seeders = parseInt(seedText);
            }

            // Alternativní heuristika pro seedy
            if (!seeders) {
                cells.each((_, cell) => {
                    const t = $(cell).text().trim();
                    if (/^\d{1,6}$/.test(t)) {
                        const n = parseInt(t);
                        if (n > 0 && n < 100000) seeders = Math.max(seeders, n);
                    }
                });
            }

            // Filtruj kategorii – přijímáme filmy a seriály
            const isMedia = !category ||
                /film|seri[aá]|movie|tv|video|xvid|x264|x265|1080|720|bluray|dvd/i.test(category + " " + title);
            if (!isMedia && category) return;

            results.push({ title, infoHash, torrentFileUrl, size, seeders, category });
        });

        // Seřaď podle seedů
        results.sort((a, b) => b.seeders - a.seeders);
        console.log(`Scrapováno ${results.length} výsledků pro: "${searchQuery}"`);
        return results;
    } catch (err) {
        console.error("Scraping chyba:", err.message);
        return [];
    }
}

// ============================================================
// Stahování .torrent souboru a extrakce hash
// (záložní metoda pokud hash není v URL)
// ============================================================
async function getHashFromTorrentFile(torrentFileUrl) {
    try {
        const headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": `${SKT_BASE}/`
        };
        if (SKT_UID && SKT_PASS) {
            headers["Cookie"] = `uid=${SKT_UID}; pass=${SKT_PASS}`;
        }

        const response = await axios.get(torrentFileUrl, {
            headers,
            responseType: "arraybuffer",
            timeout: 10000
        });

        // Parsuj bencode a extrahuj info_hash (SHA1 z info slovníku)
        // Jednoduchá implementace – najdi "4:info" a vezmi obsah do SHA1
        const buf = Buffer.from(response.data);

        // Přidej magnet přes Torbox přímo s .torrent souborem
        return { buffer: buf };
    } catch (err) {
        console.error("Stažení .torrent chyba:", err.message);
        return null;
    }
}

// ============================================================
// Torbox API funkce
// ============================================================

async function findExistingTorrent(infoHash) {
    try {
        const { data } = await axios.get(`${TORBOX_BASE}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: { bypass_cache: true },
            timeout: 15000
        });
        const list = data?.data || [];
        return list.find(t => t.hash?.toLowerCase() === infoHash.toLowerCase()) || null;
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

        if (data?.error) {
            console.error("Torbox error:", data.error, data.detail);
            // Pokud torrent už existuje, Torbox vrátí detail s ID
            if (data.detail && typeof data.detail === "object" && data.detail.torrent_id) {
                return data.detail.torrent_id;
            }
            return null;
        }

        return data?.data?.torrent_id || null;
    } catch (err) {
        console.error("Torbox addMagnet chyba:", err.message);
        return null;
    }
}

async function addTorrentFileToTorbox(torrentBuffer, name) {
    try {
        const FormData = require("form-data");
        const form = new FormData();
        form.append("torrent", torrentBuffer, {
            filename: `${name || "torrent"}.torrent`,
            contentType: "application/x-bittorrent"
        });
        form.append("seed", "1");
        form.append("allow_zip", "false");

        const { data } = await axios.post(
            `${TORBOX_BASE}/torrents/createtorrent`,
            form,
            {
                headers: {
                    Authorization: `Bearer ${TORBOX_API_KEY}`,
                    ...form.getHeaders()
                },
                timeout: 15000
            }
        );

        if (data?.error && data.detail?.torrent_id) {
            return data.detail.torrent_id;
        }

        return data?.data?.torrent_id || null;
    } catch (err) {
        console.error("Torbox addTorrentFile chyba:", err.message);
        return null;
    }
}

async function getTorboxStreamUrl(torrentId) {
    try {
        // Získej detail torrentu
        const infoRes = await axios.get(`${TORBOX_BASE}/torrents/mylist`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: { id: torrentId, bypass_cache: true },
            timeout: 15000
        });

        const torrent = infoRes.data?.data;
        if (!torrent) {
            console.log(`Torrent ID ${torrentId} nenalezen v mylist`);
            return null;
        }

        const state = torrent.download_state || torrent.status || "unknown";
        const progress = Math.round((torrent.progress || 0) * 100) / 100;

        console.log(`Torrent ${torrentId}: stav="${state}", progress=${progress}%`);

        // Stavy kdy můžeme streamovat (i při částečném stažení přes Torbox)
        const streamableStates = ["completed", "seeding", "cached", "downloading", "paused"];
        const isReady = streamableStates.some(s => state.toLowerCase().includes(s));

        if (!isReady) {
            return { url: null, state, progress };
        }

        // Vyber video soubor
        const files = torrent.files || [];
        if (!files.length) {
            console.log("Žádné soubory v torrentu");
            return null;
        }

        const videoExt = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;
        const videoFiles = files.filter(f => videoExt.test(f.name || ""));
        const candidates = videoFiles.length > 0 ? videoFiles : files;
        const biggestFile = candidates.reduce((a, b) => ((a.size || 0) > (b.size || 0) ? a : b));

        console.log(`Vybraný soubor: ${biggestFile.name} (${biggestFile.id})`);

        // Žádost o přímý link
        const linkRes = await axios.get(`${TORBOX_BASE}/torrents/requestdl`, {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            params: {
                token: TORBOX_API_KEY,
                torrent_id: torrentId,
                file_id: biggestFile.id,
                zip_link: false
            },
            timeout: 15000
        });

        const streamUrl = linkRes.data?.data;
        if (!streamUrl) {
            console.log("requestdl vrátil prázdnou URL:", JSON.stringify(linkRes.data));
            return null;
        }

        return { url: streamUrl, state: "ready", fileName: biggestFile.name };
    } catch (err) {
        console.error("getTorboxStreamUrl chyba:", err.message);
        return null;
    }
}

// ============================================================
// Hlavní resolver: torrent → Torbox → stream
// ============================================================
async function resolveViaTorbox(torrent) {
    const { infoHash, torrentFileUrl, title, size, seeders } = torrent;

    let torrentId = null;

    // 1. Pokud máme hash, zkontroluj existenci v Torboxu
    if (infoHash) {
        const existing = await findExistingTorrent(infoHash);
        if (existing) {
            torrentId = existing.id;
            console.log(`✓ Torrent nalezen v Torbox cache (id=${torrentId})`);
        } else {
            torrentId = await addMagnetToTorbox(infoHash, title);
            if (torrentId) console.log(`+ Magnet přidán do Torbox (id=${torrentId})`);
        }
    }

    // 2. Záloha: stáhni .torrent soubor a přidej ho
    if (!torrentId && torrentFileUrl) {
        console.log(`Zkouším .torrent soubor: ${torrentFileUrl}`);
        const torrentData = await getHashFromTorrentFile(torrentFileUrl);
        if (torrentData?.buffer) {
            torrentId = await addTorrentFileToTorbox(torrentData.buffer, title);
            if (torrentId) console.log(`+ .torrent přidán do Torbox (id=${torrentId})`);
        }
    }

    if (!torrentId) {
        console.log(`✗ Nepodařilo se přidat torrent: ${title}`);
        return null;
    }

    // 3. Získej stream URL
    const result = await getTorboxStreamUrl(torrentId);
    if (!result) return null;

    const sizeStr = size ? ` | ${size}` : "";
    const seedStr = seeders ? ` | 🌱 ${seeders}` : "";

    if (result.state !== "ready") {
        // Torbox teprve stahuje – ukažme progres
        const pct = result.progress || 0;
        return {
            name: `⏳ Torbox`,
            title: `${title}\n${sizeStr}${seedStr}\nStav: ${result.state} (${pct}%)`,
            externalUrl: "https://torbox.app/dashboard",
            behaviorHints: { notWebReady: true }
        };
    }

    return {
        name: `▶ Torbox`,
        title: `${title}${sizeStr}${seedStr}`,
        url: result.url,
        behaviorHints: { notWebReady: false }
    };
}

// ============================================================
// Pomocné: sestavení hledaného výrazu
// ============================================================
function buildSearchQuery(mediaInfo, season, episode) {
    const { title, year, type } = mediaInfo;

    if (type === "series" && season && episode) {
        // Formáty: "Název S01E02" nebo "Název 1x02"
        const s = String(season).padStart(2, "0");
        const e = String(episode).padStart(2, "0");
        return `${title} S${s}E${e}`;
    }

    // Film: přidej rok pro přesnější výsledky
    return year ? `${title} ${year}` : title;
}

// ============================================================
// Stremio stream handler
// ============================================================
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    const fullId = args.id; // "tt1234567" nebo "tt1234567:1:2"
    console.log(`\n=== Stream request: ${fullId} ===`);

    // Rozeber ID
    const parts = fullId.split(":");
    const imdbId = parts[0];
    const season  = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    // 1. Info z OMDb
    const mediaInfo = await getMediaInfo(imdbId);
    if (!mediaInfo?.title) {
        console.log("Název nenalezen v OMDb.");
        return { streams: [] };
    }
    console.log(`Titul: ${mediaInfo.title} (${mediaInfo.type}, ${mediaInfo.year})`);

    // 2. Sestavení dotazu
    const searchQuery = buildSearchQuery(mediaInfo, season, episode);
    console.log(`Hledám: "${searchQuery}"`);

    // 3. Scraping SKTorrent
    let torrents = await scrapeTorrents(searchQuery);

    // Pokud nic nenajdeme se S01E01 formátem, zkus i samotný název
    if (!torrents.length && season && episode) {
        console.log("Žádné výsledky pro epizodu, zkouším název titulu...");
        torrents = await scrapeTorrents(mediaInfo.title);
    }

    if (!torrents.length) {
        console.log("Žádné torrenty nenalezeny.");
        return { streams: [] };
    }
    console.log(`Nalezeno ${torrents.length} torrentů.`);

    // 4. Přidej do Torboxu a získej streamy (max 5 paralelně)
    const TOP_N = 5;
    const top = torrents.slice(0, TOP_N);

    const streamResults = await Promise.all(top.map(t => resolveViaTorbox(t)));
    const streams = streamResults.filter(Boolean);

    console.log(`Vráceno ${streams.length} streamů.\n`);
    return { streams };
});

// ============================================================
// Start serveru
// ============================================================
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅ SKTorrent+Torbox addon běží na http://127.0.0.1:${PORT}/manifest.json\n`);
console.log("⚠️  Pro přístup k sktorrent.eu nastav proměnné SKT_UID a SKT_PASS!");
console.log("   Hodnoty najdeš v cookies prohlížeče po přihlášení na sktorrent.eu\n");
