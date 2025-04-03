const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const qs = require("querystring");

const manifest = {
    id: "org.stremio.sktorrent",
    version: "1.0.4",
    name: "SKTorrent Addon",
    description: "Streamování torrentů ze sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

const LOGIN_DATA = {
    username: process.env.SKTORRENT_USERNAME || "your_username",
    password: process.env.SKTORRENT_PASSWORD || "your_password"
};

const axiosInstance = axios.create({
    baseURL: "https://sktorrent.eu",
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://sktorrent.eu/torrent/login.php" // Upravený Referer
    },
    timeout: 10000
});

async function login() {
    try {
        // Načtení přihlašovací stránky pro cookies
        const getResponse = await axiosInstance.get("/torrent/login.php");
        console.log("Načtení login stránky, status:", getResponse.status);

        // Odeslání přihlašovacích údajů
        const response = await axiosInstance.post("/torrent/login.php", qs.stringify(LOGIN_DATA));
        console.log("Přihlášení status:", response.status);
        
        if (response.status === 200 || response.status === 302) {
            console.log("Přihlášení úspěšné, cookies nastaveny");
            return true;
        }
        console.error("Přihlášení selhalo, status:", response.status);
        return false;
    } catch (error) {
        console.error("Chyba při přihlášení:", error.message);
        if (error.response) {
            console.error("Response status:", error.response.status);
            console.error("Response data:", error.response.data);
        }
        return false;
    }
}

async function getMovieTitle(imdbId) {
    const apiKey = "91fa16b4";
    const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`;
    try {
        const response = await axios.get(url, { timeout: 5000 });
        const title = response.data.Title;
        console.log(`Nalezený název pro ${imdbId}: ${title}`);
        return title || null;
    } catch (error) {
        console.error(`Chyba OMDb (${imdbId}):`, error.message);
        return null;
    }
}

async function scrapeTorrents(movieTitle) {
    const searchUrl = `/torrents_v2.php?search=${encodeURIComponent(movieTitle)}&active=0`;
    console.log("Scrapuji URL:", `https://sktorrent.eu${searchUrl}`);
    
    try {
        const response = await axiosInstance.get(searchUrl);
        console.log("Scraping status:", response.status);
        const $ = cheerio.load(response.data);
        const torrentRows = $("table.lista tr").has("td.lista");
        console.log("Nalezeno řádků torrentů:", torrentRows.length);
        
        const streams = [];
        torrentRows.each((i, element) => {
            const downloadLink = $(element).find("a[href^='download.php']").attr("href");
            const title = $(element).find("a[href^='details.php']").text().trim();
            const category = $(element).find("td.lista a[href^='torrents.php?category=']").text().trim();
            
            if (downloadLink) {
                const infoHashMatch = downloadLink.match(/id=([a-fA-F0-9]{40})/i);
                if (infoHashMatch) {
                    const infoHash = infoHashMatch[1].toLowerCase();
                    console.log("Nalezen torrent:", { title, infoHash, category });
                    if (category.includes("Filmy") || category.includes("Seriál") || category.includes("TV Pořad")) {
                        streams.push({
                            name: `SKTorrent: ${title}`,
                            infoHash: infoHash,
                            sources: [`torrent:magnet:?xt=urn:btih:${infoHash}`]
                        });
                    }
                }
            }
        });
        
        console.log("Vracím streamy:", streams);
        return streams.length > 0 ? streams : null;
    } catch (error) {
        console.error(`Chyba při scrapování (${searchUrl}):`, error.message);
        if (error.response) console.error("Response data:", error.response.data);
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    const imdbId = args.id;
    console.log(`Hledám streamy pro IMDb ID: ${imdbId}`);

    const isLoggedIn = await login();
    if (!isLoggedIn) {
        console.log("Přihlášení selhalo, vracím prázdné streamy.");
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
