const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// Manifest addonů
const manifest = {
    id: "org.stremio.sktorrent",
    version: "1.0.0",
    name: "SKTorrent Addon",
    description: "Streamování torrentů ze sktorrent.eu",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

// Funkce pro získání názvu filmu podle IMDb ID
async function getMovieTitle(imdbId) {
    const apiKey = "TVOJE_OMDB_API_KLIC"; // Získej API klíč na http://www.omdbapi.com/apikey.aspx
    const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`;
    
    try {
        const response = await axios.get(url);
        return response.data.Title; // Vrátí název filmu
    } catch (error) {
        console.error("Chyba při získávání názvu filmu:", error.message);
        return null;
    }
}

// Funkce pro scrapování torrentů podle názvu filmu
async function scrapeTorrents(movieTitle) {
    try {
        const searchUrl = `https://sktorrent.eu/torrents_v2.php?search=${encodeURIComponent(movieTitle)}&active=0`;
        const response = await axios.get(searchUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "text/html"
            }
        });
        const $ = cheerio.load(response.data);

        const torrentRows = $("table.lista tr").has("td.lista");
        const streams = [];

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
        console.error("Chyba při scrapování:", error.message);
        return null;
    }
}

// Builder addonů
const builder = new addonBuilder(manifest);

// Handler pro streamy
builder.defineStreamHandler(async (args) => {
    const imdbId = args.id;
    console.log(`Hledám streamy pro IMDb ID: ${imdbId}`);

    // Nejprve získáme název filmu
    const movieTitle = await getMovieTitle(imdbId);
    if (!movieTitle) {
        return Promise.resolve({ streams: [] }); // Pokud nenajdeme název, nevracíme nic
    }

    console.log(`Nalezený název: ${movieTitle}`);

    // Hledáme torrenty podle názvu filmu
    const streams = await scrapeTorrents(movieTitle);
    if (streams) {
        return Promise.resolve({ streams });
    }
    
    return Promise.resolve({ streams: [] });
});

// Spuštění serveru
const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`Addon běží na http://127.0.0.1:${port}/manifest.json`);

