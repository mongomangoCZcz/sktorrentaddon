const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const qs = require("querystring");

const manifest = {
    id: "org.stremio.sktorrent",
    version: "1.0.7",
    name: "SKTorrent Addon",
    description: "Streamování torrentů ze sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

const LOGIN_DATA = {
    username: process.env.SKTORRENT_USERNAME || "jozkonevicist",
    password: process.env.SKTORRENT_PASSWORD || "xekryt-wosjop-6kIdbo"
};

const axiosInstance = axios.create({
    baseURL: "https://sktorrent.eu",
    headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://sktorrent.eu/torrent/login.php"
    },
    timeout: 10000,
    withCredentials: true
});

async function login() {
    try {
        await axiosInstance.get("/torrent/login.php");
        const response = await axiosInstance.post("/torrent/login.php", qs.stringify(LOGIN_DATA));
        console.log("Login status:", response.status);
        return response.status === 200 || response.status === 302;
    } catch (error) {
        console.error("Chyba při přihlášení:", error.message);
        return false;
    }
}

async function getMovieTitle(imdbId) {
    const apiKey = "91fa16b4";
    const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`;
    try {
        const response = await axios.get(url, { timeout: 5000 });
        console.log("OMDb název:", response.data.Title);
        return response.data.Title || null;
    } catch (error) {
        console.error(`Chyba OMDb (${imdbId}):`, error.message);
        return null;
    }
}

async function scrapeTorrents(movieTitle) {
    const searchUrl = `/torrent/torrents_v2.php?search=${encodeURIComponent(movieTitle)}&active=0`;
    console.log("Scrapuji URL:", `https://sktorrent.eu${searchUrl}`);

    try {
        const response = await axiosInstance.get(searchUrl);
        const $ = cheerio.load(response.data);
        const rows = $("table.lista tr");

        const streams = [];

        rows.each((i, row) => {
            const cells = $(row).find("td.lista");
            if (cells.length > 1) {
                const linkEl = $(cells[1]).find("a[href^='details.php']");
                const detailLink = linkEl.attr("href");
                const title = linkEl.text().trim();

                const seeds = parseInt($(cells[6]).text().trim()) || 0;
                const leechers = parseInt($(cells[7]).text().trim()) || 0;

                const category = $(cells[0]).text().trim();
                const infoHashMatch = detailLink ? detailLink.match(/id=([a-fA-F0-9]{40})/) : null;
                const infoHash = infoHashMatch ? infoHashMatch[1].toLowerCase() : null;

                if (detailLink && infoHash && seeds > 0) {
                    console.log(`→ Nalezen torrent: ${title} | Seeds: ${seeds} | Kategorie: ${category}`);

                    streams.push({
                        name: `SKTorrent: ${title} (${seeds} seedů)`,
                        infoHash: infoHash,
                        sources: [
                            `magnet:?xt=urn:btih:${infoHash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://tracker.leechers-paradise.org:6969/announce`
                        ]
                    });
                }
            }
        });

        console.log("Celkem nalezeno streamů:", streams.length);
        return streams.length > 0 ? streams : null;
    } catch (error) {
        console.error(`Chyba při scrapování (${searchUrl}):`, error.message);
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    const imdbId = args.id;
    console.log(`Hledám streamy pro IMDb ID: ${imdbId}`);

    const isLoggedIn = await login();
    if (!isLoggedIn) {
        console.log("❌ Přihlášení selhalo");
        return { streams: [] };
    }

    const movieTitle = await getMovieTitle(imdbId);
    if (!movieTitle) {
        console.log("❌ Nepodařilo se získat název z OMDb");
        return { streams: [] };
    }

    const streams = await scrapeTorrents(movieTitle);
    return { streams: streams || [] };
});

const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`✅ Addon běží na http://127.0.0.1:${port}/manifest.json`);
