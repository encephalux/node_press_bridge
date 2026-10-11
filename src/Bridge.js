'use strict';

const fs_p = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const env = require("./env");
const axios = require("axios");
const MetadataFile = require("./MetadataFile");
const utils = require("./utils");

class Bridge {
    constructor({target, options = {}}) {
        this.options = Object.assign({
            post_types: ["page", "post"],
            types_to_buffer: ["page"],
        }, options);
        this.target = target;
        this.cache_dir = path.join(env.DIR, "contents");
        this.metadata_file = new MetadataFile();
        this.data = {};
        this.initialized = !1;
        this.pending = new Set();
        this.destroying = null;
    }

    get metadata() {
        return this.metadata_file.data;
    }

    get_post_file_path(post_type, post) {
        return path.join(this.cache_dir, post_type, `${post.uuid}.html`);
    }

    get_post_type_dir(post_type) {
        return path.join(this.cache_dir, post_type);
    }

    async init() {
        await this.metadata_file.load();

        try {
            await fs_p.mkdir(this.cache_dir, {recursive: !0});

            let stack = [];
            for(const post_type of this.options.post_types)
                stack.push((async () => {
                    await fs_p.mkdir(this.get_post_type_dir(post_type), {recursive: !0});
                    if(this.options.types_to_buffer.includes(post_type)) this.data[post_type] = {};
                    if(!this.metadata.hasOwnProperty(post_type)) this.metadata[post_type] = {};
                })());
            await Promise.all(stack);

            for(const post_type of this.options.types_to_buffer)
                for(const id in this.metadata[post_type])
                    if(this.metadata[post_type].hasOwnProperty(id) && this.metadata[post_type][id].status === "published")
                        await this._buffer(post_type, id)
                            .catch(err => utils.log({message: "BUFFERING FAILED ON INIT", res: {post_type, id, slug: this.metadata[post_type][id].slug}, reason: err}));

            await this.metadata_file.save();
        } catch(err) {
            await this.metadata_file.close();
            throw err;
        }

        this.initialized = !0;
    }

    async destroy() {
        if(this.destroying) return this.destroying;
        if(!this.initialized) return;

        this.destroying = (async () => {
            while(this.pending.size)
                await Promise.allSettled(this.pending);

            this.initialized = !1;
            try {
                await this.metadata_file.save();
            } finally {
                await this.metadata_file.close();
                this.data = {};
            }
        })().finally(() => this.destroying = null);

        return this.destroying;
    }

    // { TODO: a remove() received while this download is running (register, update, update_cache)
    //   leaves an orphan HTML file. Check that this.metadata[post_type][id] still exists after the
    //   rename and delete the file otherwise. }
    async _download(post_type, post, options = {}) {
        const post_file = this.get_post_file_path(post_type, post);
        const tmp = `${post_file}.${crypto.randomUUID()}.tmp`;

        const res = await axios.get(`${this.target.url}/${post.slug}`, {signal: options.signal, responseType: "stream"})
            .catch(err => {
                utils.log({message: "FAILED TO GET POST CONTENT", res: {post_type, post}});
                throw err;
            });

        try {
            await fs_p.writeFile(tmp, res.data);
            await fs_p.rename(tmp, post_file);
        } catch(err) {
            utils.log({message: "ERROR ON POST FILE WRITING", res: {post_type, post}});
            await fs_p.rm(tmp, {force: !0});
            throw err;
        }
    }

    async _buffer(post_type, id) {
        this.data[post_type][id] = await fs_p.readFile(this.get_post_file_path(post_type, this.metadata[post_type][id]), {encoding: "utf8"})
            .catch(err => {
                this.data[post_type][id] = null;
                throw err;
            });
        return this.data[post_type][id];
    }

    async register({post_type, id, slug, title, excerpt, date, author, thumbnail, status}) {
        if(!this.initialized) throw new Error("NOT_INITIALIZED");

        if(!this.options.post_types.includes(post_type)) {
            utils.log({message: "REGISTERING UNSUPPORTED POST TYPE", res: {post_type, id, slug}});
            throw new Error("UNSUPPORTED_POST_TYPE");
        }

        if(this.metadata[post_type].hasOwnProperty(id)) {
            utils.log({message: "REGISTERING REGISTERED POST", res: {post_type, id, slug}});
            throw new Error("ALREADY_REGISTERED_POST");
        }

        this.metadata[post_type][id] = {
            uuid: crypto.randomUUID(),
            slug,
            title,
            date,
            author,
            thumbnail,
            status
        };

        if(post_type === "post") {
            this.metadata[post_type][id].excerpt = excerpt;
        }

        await this.metadata_file.save();

        if(status === "published")
            await this._download(post_type, this.metadata[post_type][id])
                .then(() => {
                    if(this.options.types_to_buffer.includes(post_type)) {
                        return this._buffer(post_type, id);
                    }
                })
                .catch(() => null);
    }

    async update({post_type, id, slug, title, excerpt, date, author, thumbnail, status}) {
        if(!this.initialized) throw new Error("NOT_INITIALIZED");

        if(!this.options.post_types.includes(post_type)) {
            utils.log({message: "UPDATING UNSUPPORTED POST TYPE", res: {post_type, id, slug}});
            throw new Error("UNSUPPORTED_POST_TYPE");
        }

        let data = this.metadata[post_type][id];
        if(!data) return utils.log({message: "UNREGISTERED POST UPDATING", res: {post_type, id, slug}});

        if(slug === "" || slug) data.slug =  slug;
        if(title === "" || title) data.title = title;
        if(date) data.date = date;
        if(author) data.author = author;
        if(thumbnail) data.thumbnail = thumbnail;
        if(status === "" || status) data.status = status;

        if(post_type === "post") {
            if(excerpt === "" || excerpt) data.excerpt = excerpt;
        }

        await this.metadata_file.save();

        if(data.status === "published")
            await this._download(post_type, data)
                .then(() => {
                    if(this.options.types_to_buffer.includes(post_type)) {
                        return this._buffer(post_type, id);
                    }
                })
                .catch(err => null);
    }

    async remove({post_type, id}) {
        if(!this.initialized) throw new Error("NOT_INITIALIZED");

        if(!this.options.post_types.includes(post_type)) {
            utils.log({message: "REMOVING UNSUPPORTED POST TYPE", res: {post_type, id}});
            throw new Error("UNSUPPORTED_POST_TYPE");
        }

        if(!this.metadata[post_type].hasOwnProperty(id))
            return utils.log({message: "UNREGISTERED POST REMOVING", res: {post_type, id}});

        const post = this.metadata[post_type][id];

        if(this.options.types_to_buffer.includes(post_type))
            delete this.data[post_type][id];
        delete this.metadata[post_type][id];

        await this.metadata_file.save();

        await fs_p.unlink(this.get_post_file_path(post_type, post))
            .catch(err => err.code !== "ENOENT" && utils.log({message: "FAILED TO REMOVE POST HTML FILE", res: {post_type, id, ...post}, reason: err}));
    }

    async _get(post_type, id) {
        const post = this.metadata[post_type][id];
        if(post.status === "published") {
            let resource =  {...post};

            if(this.options.types_to_buffer.includes(post_type)) {
                resource.content = this.data[post_type][id] ?? await this._buffer(post_type, id)
                    .catch(err => {
                        utils.log({message: "CAN'T READ PUBLISHED POST FILE", res: {post_type, id}, reason: err});
                        throw new Error("CACHED_READ_ERROR");
                    });
                return resource;
            }

            return fs_p.readFile(this.get_post_file_path(post_type, post), {encoding: "utf8"})
                .then(data => {
                    resource.content = data;
                    return resource;
                })
                .catch(err => {
                    utils.log({message: "CAN'T READ PUBLISHED POST FILE", res: {post_type, id}, reason: err});
                    throw new Error("CACHED_READ_ERROR");
                });
        }
        throw new Error("UNPUBLISHED_POST");
    }

    async get_by_id(post_type, id) {
        if(!this.initialized) throw new Error("NOT_INITIALIZED");

        if(!this.options.post_types.includes(post_type)) {
            utils.log({message: "REQUESTING UNSUPPORTED POST TYPE CACHED FILE", res: {post_type, id}});
            throw new Error("UNSUPPORTED_POST_TYPE");
        }

        if(this.metadata[post_type].hasOwnProperty(id))
            return this._get(post_type, id);

        throw new Error("POST_NOT_FOUND");
    }

    async get_by_slug(post_type, slug) {
        if(!this.initialized) throw new Error("NOT_INITIALIZED");

        if(!this.options.post_types.includes(post_type)) {
            utils.log({message: "REQUESTING UNSUPPORTED POST TYPE CACHED FILE", res: {post_type, slug}});
            throw new Error("UNSUPPORTED_POST_TYPE");
        }

        for(let id in this.metadata[post_type]) {
            if(this.metadata[post_type].hasOwnProperty(id) && this.metadata[post_type][id].slug === slug && this.metadata[post_type][id].status === "published")
                return this._get(post_type, id);
        }

        throw new Error("POST_NOT_FOUND");
    }

    async update_cache() {
        if(!this.initialized) throw new Error("NOT_INITIALIZED");

        for(const post_type of this.options.post_types) {
            for(const id in this.metadata[post_type]) {
                if(!this.metadata[post_type].hasOwnProperty(id) || this.metadata[post_type][id].status !== "published")
                    continue;
                try {
                    const post = this.metadata[post_type][id];
                    await this._download(post_type, post)
                        .catch(err => {
                            utils.log({
                                message: "DOWNLOAD FAILED ON CACHE UPDATING" ,
                                res: {post_type, id},
                                reason: err
                            });
                            throw new Error("DOWNLOAD_FAILED");
                        });
                    if (this.options.types_to_buffer.includes(post_type))
                        await this._buffer(post_type, id);
                } catch(err) {
                    if(err.message !== "DOWNLOAD_FAILED")
                        utils.log({
                            message: "BUFFERING FAILED ON CACHE UPDATING",
                            res: {post_type, id},
                            reason: err
                        });
                }
            }
        }
    }
}

// { Writing operations: refused during destroy() and awaited by it }
["register", "update", "remove", "update_cache"].forEach(name => {
    const operation = Bridge.prototype[name];

    Bridge.prototype[name] = function(...args) {
        if(this.destroying) return Promise.reject(new Error("DESTROYING"));

        const promise = operation.apply(this, args);
        const done = () => this.pending.delete(promise);
        this.pending.add(promise);
        promise.then(done, done);
        return promise;
    };
});

module.exports = Bridge;
