module.exports = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");

    res.json({
        id: "org.stremio.sktorrent-torbox",
        version: "3.0.0",
        name: "SKTorrent + Torbox",
        description: "Streamování přes Torbox z torrentů nalezených na sktorrent.eu",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt"],
        catalogs: []
    });
};
