const env = require("./env");
const path = require("path");
const fs_p = require("fs/promises");
const utils = require("./utils");

module.exports = class MetadataFile {
    constructor() {
        this.path = path.join(env.DIR, "metadata.json");
        this.data = null;
        this.handle = null;
        this.writing = Promise.resolve();
    }

    async load() {
        await this.close();
        await fs_p.mkdir(env.DIR, {recursive: !0});
        const handle = await fs_p.open(this.path, "r+")
            .catch(async err => {
                if(err.code === "ENOENT") {
                    await fs_p.writeFile(this.path, "{}");
                    return fs_p.open(this.path, "r+");
                }
                throw err;
            });

        try {
            this.data = JSON.parse(await handle.readFile("utf8"));
        } catch(err) {
            utils.log({message: "ERROR ON METADATA PARSING"});
            await handle.close();
            throw err;
        }

        this.handle = handle;
        return this.data;
    }

    async save() {
        if(!this.handle)
            throw new Error("METADATA_CLOSED");

        const handle = this.handle;
        const write = this.writing.then(async () => {
            const json = JSON.stringify(this.data);
            await handle.truncate(0);
            await handle.write(json, 0, "utf8");
        });

        this.writing = write.catch(err => utils.log({message: "METADATA FILE WRITING FAILED", res: err}));
        return write;
    }

    async close() {
        if(!this.handle) return;

        const handle = this.handle;
        this.handle = null;
        await this.writing;
        await handle.close();
    }
}
