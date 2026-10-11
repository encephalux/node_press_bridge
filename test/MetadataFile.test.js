const {test} = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs_p = require("fs/promises");
const env = require("../src/env");
const MetadataFile = require("../src/MetadataFile");
const {make_dir} = require("./helpers");

test("load() crée le répertoire et un registre vide", async () => {
    env.DIR = path.join(await make_dir(), "a", "b");
    const file = new MetadataFile();

    assert.deepStrictEqual(await file.load(), {});
    assert.strictEqual(await fs_p.readFile(path.join(env.DIR, "metadata.json"), "utf8"), "{}");
    await file.close();
});

test("save() remplace le contenu au lieu de l'ajouter", async () => {
    env.DIR = await make_dir();
    const file = new MetadataFile();
    await file.load();

    file.data = {page: {1: {slug: "un-slug-assez-long"}}};
    await file.save();
    file.data = {page: {}};
    await file.save();
    await file.close();

    const raw = await fs_p.readFile(path.join(env.DIR, "metadata.json"), "utf8");
    assert.deepStrictEqual(JSON.parse(raw), {page: {}});
});

test("load() relit un registre existant", async () => {
    env.DIR = await make_dir();
    await fs_p.writeFile(path.join(env.DIR, "metadata.json"), '{"post":{"2":{"slug":"x"}}}');
    const file = new MetadataFile();

    assert.deepStrictEqual(await file.load(), {post: {2: {slug: "x"}}});
    await file.close();
});

test("load() échoue sur un JSON invalide et referme le fichier", async () => {
    env.DIR = await make_dir();
    await fs_p.writeFile(path.join(env.DIR, "metadata.json"), "{}{}");
    const file = new MetadataFile();

    await assert.rejects(file.load(), SyntaxError);
    assert.strictEqual(file.handle, null);
});

test("load() ferme le fichier précédemment ouvert", async () => {
    env.DIR = await make_dir();
    const file = new MetadataFile();
    await file.load();
    const previous = file.handle;

    await file.load();
    assert.strictEqual(previous.fd, -1);
    assert.notStrictEqual(file.handle, previous);
    await file.close();
});

test("les sauvegardes simultanées produisent un JSON valide", async () => {
    env.DIR = await make_dir();
    const file = new MetadataFile();
    await file.load();

    const saves = [];
    for(let i = 50; i > 0; i--) {
        file.data = {page: {1: {slug: "x".repeat(i * 100)}}};
        saves.push(file.save());
        file.data = {page: {}};
        saves.push(file.save());
    }
    await Promise.all(saves);
    await file.close();

    const raw = await fs_p.readFile(path.join(env.DIR, "metadata.json"), "utf8");
    assert.deepStrictEqual(JSON.parse(raw), {page: {}});
});

test("close() attend les sauvegardes en cours", async () => {
    env.DIR = await make_dir();
    const file = new MetadataFile();
    await file.load();

    file.data = {post: {}};
    const saving = file.save();
    await file.close();
    await saving;

    const raw = await fs_p.readFile(path.join(env.DIR, "metadata.json"), "utf8");
    assert.deepStrictEqual(JSON.parse(raw), {post: {}});
});

test("close() peut être appelé plusieurs fois ou avant load()", async () => {
    env.DIR = await make_dir();
    const file = new MetadataFile();
    await file.close();
    await file.load();
    await file.close();
    await file.close();
});

test("save() est refusé une fois le fichier fermé", async () => {
    env.DIR = await make_dir();
    const file = new MetadataFile();
    await assert.rejects(file.save(), /METADATA_CLOSED/);

    await file.load();
    await file.close();
    await assert.rejects(file.save(), /METADATA_CLOSED/);
});
