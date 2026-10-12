const http = require("http");
const os = require("os");
const path = require("path");
const fs_p = require("fs/promises");
const env = require("../src/env");
const utils = require("../src/utils");
const Bridge = require("../src/Bridge");

// { Silence module logs during tests }
utils.log = () => {};

/**
 * Fake WordPress: answers `<html>{version}:{slug}</html>` for any slug,
 * except slugs listed in `missing` which answer 404. Responses are sent after `delay` ms.
 */
async function start_wordpress() {
    const wp = {version: 1, missing: new Set(), hits: [], delay: 0};

    wp.server = http.createServer((req, res) => {
        const slug = req.url.slice(1);
        wp.hits.push(slug);
        setTimeout(() => {
            if(wp.missing.has(slug)) {
                res.statusCode = 404;
                return res.end();
            }
            res.end(`<html>${wp.version}:${slug}</html>`);
        }, wp.delay);
    });

    await new Promise(resolve => wp.server.listen(0, "127.0.0.1", resolve));
    wp.url = `http://127.0.0.1:${wp.server.address().port}`;
    wp.close = () => new Promise(resolve => wp.server.close(resolve));
    return wp;
}

async function make_dir() {
    return fs_p.mkdtemp(path.join(os.tmpdir(), "press_bridge-"));
}

/** Creates (without initializing) a Bridge working in `dir`. */
function new_bridge(dir, url, options) {
    env.DIR = dir;
    return new Bridge({target: {url}, options});
}

async function init_bridge(dir, url, options) {
    const bridge = new_bridge(dir, url, options);
    await bridge.init();
    return bridge;
}

const page = (fields = {}) => ({
    post_type: "page",
    id: "1",
    slug: "a-propos",
    title: "À propos",
    date: "2026-10-01T10:00:00",
    author: "admin",
    thumbnail: "",
    status: "published",
    ...fields
});

const post = (fields = {}) => ({
    post_type: "post",
    id: "2",
    slug: "premier-article",
    title: "Premier article",
    excerpt: "Résumé",
    date: "2026-10-05T08:30:00",
    author: "admin",
    thumbnail: "",
    status: "published",
    ...fields
});

const exists = file => fs_p.stat(file).then(() => true, () => false);

module.exports = {start_wordpress, make_dir, new_bridge, init_bridge, page, post, exists};
