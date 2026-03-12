const axios = require("axios");
const cheerio = require("cheerio");

const SKT_UID  = process.env.SKT_UID  || "909010";
const SKT_PASS = process.env.SKT_PASS || "875b64631dbcc07284d9ae5c81423669";
const SKT_BASE = "https://sktorrent.eu/torrent";

module.exports = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    const query = req.query.q || "Avengers";
    const url = `${SKT_BASE}/torrents_v2.php?search=${encodeURIComponent(query)}&active=0`;

    const result = { query, url, status: null, rowCount: 0, torrents: [], htmlSnippet: "", error: null };

    try {
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "cs-CZ,cs;q=0.9",
            "Referer": `${SKT_BASE}/`,
            "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`
        };

        const { data, status } = await axios.get(url, { headers, timeout: 20000 });
        result.status = status;

        // Ulož první část HTML pro debug
        result.htmlSnippet = data.substring(0, 3000);

        const $ = cheerio.load(data);

        // Spočítej všechny řádky tabulky
        result.rowCount = $("table tr").length;
        result.allAnchors = [];

        // Najdi všechny odkazy pro debug
        $("a").each((_, el) => {
            const href = $(el).attr("href") || "";
            if (href.includes("details.php") || href.includes("download.php")) {
                result.allAnchors.push({ href, text: $(el).text().trim().substring(0, 50) });
            }
        });

        // Zkus parsovat torrenty
        $("table tr").each((_, el) => {
            const row = $(el);
            const detailLink = row.find("a[href*='details.php']");
            const dlLink     = row.find("a[href*='download.php']");

            if (!detailLink.length) return;

            const title   = detailLink.text().trim();
            const dlHref  = dlLink.attr("href") || "";
            const detHref = detailLink.attr("href") || "";

            const hashMatch = (dlHref + " " + detHref).match(/[?&]id=([a-fA-F0-9]{40})/i);

            result.torrents.push({
                title,
                dlHref,
                detHref,
                hashFound: !!hashMatch,
                hash: hashMatch ? hashMatch[1] : null
            });
        });

    } catch (err) {
        result.error = err.message;
    }

    res.json(result);
};
