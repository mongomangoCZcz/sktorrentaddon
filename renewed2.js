const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const qs = require("querystring");

// Manifest addonů
const manifest = {
    id: "org.stremio.sktorrent",
    version: "1.0.3",
    name: "SKTorrent Addon",
    description: "Streamování torrentů ze sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

// Načtení přihlašovacích údajů z proměnných prostředí
const LOGIN_DATA = {
    username: process.env.SKTORRENT_USERNAME || "jozkonevicist", // Výchozí hodnota pro lokální testování
    password: process.env.SKTORRENT_PASSWORD || "xekryt-wosjop-6kIdbo"  // Výchozí hodnota pro lokální testování
};

// Globální instance axios s cookies
const axiosInstance = axios.create({
    baseURL: "https://sktorrent.eu",
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html",
        "Content-Type": "application/x-www-form-urlencoded"
    },
    timeout: 10000
});

// Funkce pro přihlášení
async function login() {
    try {
        const response = await axiosInstance.post("/login.php", qs.stringify(LOGIN_DATA));
        if (response.status === 200) {
            console.log("Přihlášení úspěšné");
            return true;
        }
        console.error("Přihlášení selhalo, status:", response.status);
        return false;
    } catch (error) {
        console.error("Chyba při přihlášení:", error.message);
        return false;
    }
}

// Funkce pro získání názvu filmu podle IMDb ID
async function getMovieTitle(imdbId) {
    const apiKey = "91fa16b4";
    const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`;
    
    try {
        const response = await axios.get(url, { timeout: 5000 });
        return response.data.Title || null;
    } catch (error) {
        console.error(`Chyba při získávání názvu (${imdbId}):`, error.message);
        return null;
    }
}

// Funkce pro scrapování torrentů
async function scrapeTorrents(movieTitle) {
    const searchUrl = `/torrents_v2.php?search=${encodeURIComponent(movieTitle)}&active=0`;
    
    try {
        const response = await axiosInstance.get(searchUrl);
        const $ = cheerio.load(response.data);
        const torrentRows = $("table.lista tr").has("td.lista");
        const streams = [];

        if (torrentRows.length === 0) {
            console.log(`Žádné torrenty nenalezeny pro "${movieTitle}"`);
            return null;
        }

        torrentRows.each((i, element) => {
            const downloadLink = $(element).find("a[href^='download.php']").attr("href");
            const titleElement = $(element).find("a[href^='details.php']");
            const title = titleElement.text().trim();
            const category = $(element).find("td.lista a[href^='torrents.php?category=']").text().trim();

            if (downloadLink) {
                const infoHashMatch = downloadLink.match(/id=([a-fA-F0-9]{40})/i);
                if (infoHashMatch) {
                    const infoHash = infoHashMatch[1].toLowerCase();
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

        return streams.length > 0 ? streams : null;
    } catch (error) {
        console.error(`Chyba při scrapování (${searchUrl}):`, error.message);
        if (error.response && error.response.status === 404) {
            console.error("Stránka nenalezena (404). Zkontrolujte přihlášení nebo URL.");
        }
        return null;
    }
}

// Builder addonů
const builder = new addonBuilder(manifest);

// Handler pro streamy
builder.defineStreamHandler(async (args) => {
    const imdbId = args.id;
    console.log(`Hledám streamy pro IMDb ID: ${imdbId}`);

    // Přihlášení před prvním požadavkem
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

    console.log(`Nalezený název: ${movieTitle}`);
    const streams = await scrapeTorrents(movieTitle);
    return { streams: streams || [] };
});

// Spuštění serveru
const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`Addon běží na http://127.0.0.1:${port}/manifest.json`);
