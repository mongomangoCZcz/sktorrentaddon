const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const qs = require("querystring");

const manifest = {
    id: "org.stremio.sktorrent",
    version: "1.0.6",
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
        return response.data.Title || null;
    } catch (error) {
        console.error(`Chyba OMDb (${imdbId}):`, error.message);
        return null;
    }
}

async function scrapeTorrents(movieTitle) {
    const searchUrl = `/torrent/torrents_v2.php?search=${encodeURIComponent(movieTitle)}&active=0`;
    try {
        const response = await axiosInstance.get(searchUrl);
        const $ = cheerio.load(response.data);
        const torrentRows = $("table.lista td.lista");

        const streams = [];

        for (let i = 0; i < torrentRows.length; i++) {
            const element = torrentRows[i];
            const detailLink = $(element).find("a[href^='details.php']").attr("href");
            const title = $(element).find("a[href^='details.php']").text().trim();
            const categoryElement = $(element).find("a[href^='torrents_v2.php?category=']");
            const category = categoryElement.length ? categoryElement.text().trim() : "";
            const seedText = $(element).text().match(/Odosielaju : (\d+)/);
            const seeds = seedText ? parseInt(seedText[1]) : 0;
            const leechText = $(element).text().match(/Stahuju : (\d+)/);
            const leechers = leechText ? parseInt(leechText[1]) : 0;

            if (detailLink && seeds > 0) {
                const infoHashMatch = detailLink.match(/id=([a-fA-F0-9]{40})/i);
                if (infoHashMatch) {
                    const infoHash = infoHashMatch[1].toLowerCase();

                    const detailResponse = await axiosInstance.get(`/torrent/${detailLink}`);
                    const $detail = cheerio.load(detailResponse.data);
                    const downloadLink = $detail("a[href^='download.php']").attr("href");

                    if (downloadLink && (category.includes("Filmy") || category.includes("Seriál") || category.includes("TV Pořad"))) {
                        streams.push({
                            name: `SKTorrent: ${title} (${seeds} seedů)`,
                            infoHash: infoHash,
                            sources: [
                                `magnet:?xt=urn:btih:${infoHash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://tracker.leechers-paradise.org:6969/announce`
                            ]
                        });
                    }
                }
            }
        }

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
        console.log("Přihlášení selhalo.");
        return { streams: [] };
    }

    const movieTitle = await getMovieTitle(imdbId);
    if (!movieTitle) {
        console.log(`Není dostupný název pro ${imdbId}`);
        return { streams: [] };
    }

    const streams = await scrapeTorrents(movieTitle);
    return { streams: streams || [] };
});

const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`Addon běží na http://127.0.0.1:${port}/manifest.json`);
