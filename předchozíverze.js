const { addonBuilder, serveHTTP } = require("stremio-addon-sdk"); // Přidáno serveHTTP
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

// Funkce pro scrapování torrentů
async function scrapeTorrents(imdbId) {
    try {
        const searchUrl = `https://sktorrent.eu/torrents_v2.php?search=${imdbId}&active=0`;
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
    const streams = await scrapeTorrents(imdbId);
    if (streams) {
        return Promise.resolve({ streams });
    }
    return Promise.resolve({ streams: [] });
});

// Spuštění serveru
const port = 7225;
serveHTTP(builder.getInterface(), { port }); // Použití serveHTTP z SDK
console.log(`Addon běží na http://127.0.0.1:${port}/manifest.json`);