const {describe, test, before, after, beforeEach, afterEach} = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs_p = require("fs/promises");
const {start_wordpress, make_dir, new_bridge, init_bridge, page, post, exists} = require("./helpers");

describe("Bridge", () => {
    let wp, dir, bridge;

    before(async () => wp = await start_wordpress());
    after(() => wp.close());

    beforeEach(async () => {
        wp.version = 1;
        wp.delay = 0;
        wp.missing.clear();
        wp.hits.length = 0;
        dir = await make_dir();
        bridge = await init_bridge(dir, wp.url);
    });

    afterEach(() => bridge.destroy());

    const html_file = (post_type, id) => bridge.get_post_file_path(post_type, bridge.metadata[post_type][id]);
    const read_registry = async () => JSON.parse(await fs_p.readFile(path.join(dir, "metadata.json"), "utf8"));

    describe("init()", () => {
        test("crée les répertoires et le registre", async () => {
            assert.ok(await exists(bridge.get_post_type_dir("page")));
            assert.ok(await exists(bridge.get_post_type_dir("post")));
            assert.deepStrictEqual(bridge.metadata, {page: {}, post: {}});
            assert.deepStrictEqual(bridge.data, {page: {}});
            assert.strictEqual(bridge.initialized, true);
        });

        test("ferme metadata.json si l'initialisation échoue", async () => {
            const other = await make_dir();
            await fs_p.writeFile(path.join(other, "contents"), "");
            const failing = new_bridge(other, wp.url);

            await assert.rejects(failing.init());
            assert.strictEqual(failing.metadata_file.handle, null);
            assert.strictEqual(failing.initialized, false);
        });

        test("les méthodes refusent un bridge non initialisé", async () => {
            const fresh = new_bridge(await make_dir(), wp.url);
            await assert.rejects(fresh.register(page()), /NOT_INITIALIZED/);
            await assert.rejects(fresh.get_by_id("page", 1), /NOT_INITIALIZED/);
            await assert.rejects(fresh.get_by_slug("page", "a-propos"), /NOT_INITIALIZED/);
        });

        test("recharge en mémoire les contenus publiés", async () => {
            await bridge.register(page());
            await bridge.destroy();

            bridge = await init_bridge(dir, wp.url);
            assert.strictEqual(bridge.data.page[1], "<html>1:a-propos</html>");
        });

        test("ne bloque pas sur un brouillon ou un fichier manquant", async () => {
            await bridge.register(page());
            await bridge.register(page({id: 3, slug: "brouillon", status: "draft"}));
            await fs_p.unlink(html_file("page", 1));
            await bridge.destroy();

            bridge = await init_bridge(dir, wp.url);
            assert.strictEqual(bridge.data.page[1], null);
            assert.strictEqual(bridge.data.page[3], undefined);
            await assert.rejects(bridge.get_by_id("page", 1), /CACHED_READ_ERROR/);
        });
    });

    describe("register()", () => {
        test("met en cache et en mémoire une page publiée", async () => {
            await bridge.register(page());

            const entry = bridge.metadata.page[1];
            assert.match(entry.uuid, /^[0-9a-f-]{36}$/);
            assert.strictEqual(entry.slug, "a-propos");
            assert.strictEqual(entry.excerpt, undefined);
            assert.strictEqual(await fs_p.readFile(html_file("page", 1), "utf8"), "<html>1:a-propos</html>");
            assert.strictEqual(bridge.data.page[1], "<html>1:a-propos</html>");
        });

        test("met en cache un article publié sans le mettre en mémoire", async () => {
            await bridge.register(post());

            assert.strictEqual(bridge.metadata.post[2].excerpt, "Résumé");
            assert.ok(await exists(html_file("post", 2)));
            assert.strictEqual(bridge.data.post, undefined);
        });

        for(const [label, make] of [["une page", page], ["un article", post]]) {
            test(`n'interroge pas WordPress pour ${label} non publié`, async () => {
                const draft = make({status: "draft"});
                await bridge.register(draft);

                assert.ok(bridge.metadata[draft.post_type][draft.id]);
                assert.deepStrictEqual(wp.hits, []);
                assert.strictEqual(await exists(html_file(draft.post_type, draft.id)), false);
            });
        }

        test("WordPress envoie \"publish\" : le contenu n'est pas mis en cache", async () => {
            await bridge.register(page({status: "publish"}));
            assert.deepStrictEqual(wp.hits, []);
        });

        test("enregistre le contenu même si WordPress échoue", async () => {
            wp.missing.add("a-propos");
            await bridge.register(page());

            assert.ok(bridge.metadata.page[1]);
            assert.strictEqual(await exists(html_file("page", 1)), false);
        });

        test("sauvegarde le registre", async () => {
            await bridge.register(post());
            assert.strictEqual((await read_registry()).post[2].slug, "premier-article");
        });

        test("refuse un doublon", async () => {
            await bridge.register(page());
            await assert.rejects(bridge.register(page()), /ALREADY_REGISTERED_POST/);
        });

        test("refuse un type non géré", async () => {
            await assert.rejects(bridge.register(page({post_type: "product"})), /UNSUPPORTED_POST_TYPE/);
        });
    });

    describe("update()", () => {
        test("ne remplace que les champs fournis", async () => {
            await bridge.register(post());
            await bridge.update({post_type: "post", id: 2, title: "Nouveau titre", excerpt: ""});

            const entry = bridge.metadata.post[2];
            assert.strictEqual(entry.title, "Nouveau titre");
            assert.strictEqual(entry.excerpt, "");
            assert.strictEqual(entry.slug, "premier-article");
            assert.strictEqual(entry.author, "admin");
        });

        test("retélécharge le HTML et suit le changement de slug", async () => {
            await bridge.register(page());
            wp.version = 2;
            await bridge.update({post_type: "page", id: 1, slug: "qui-sommes-nous"});

            assert.strictEqual(bridge.data.page[1], "<html>2:qui-sommes-nous</html>");
            assert.strictEqual((await bridge.get_by_slug("page", "qui-sommes-nous")).content, "<html>2:qui-sommes-nous</html>");
            await assert.rejects(bridge.get_by_slug("page", "a-propos"), /POST_NOT_FOUND/);
        });

        test("publie un brouillon", async () => {
            await bridge.register(post({status: "draft"}));
            await bridge.update({post_type: "post", id: 2, status: "published"});

            assert.strictEqual((await bridge.get_by_id("post", 2)).content, "<html>1:premier-article</html>");
        });

        test("dépublie un contenu", async () => {
            await bridge.register(page());
            await bridge.update({post_type: "page", id: 1, status: "draft"});

            await assert.rejects(bridge.get_by_id("page", 1), /UNPUBLISHED_POST/);
            await assert.rejects(bridge.get_by_slug("page", "a-propos"), /POST_NOT_FOUND/);
        });

        test("ignore un contenu non enregistré", async () => {
            await bridge.update(page());
            assert.deepStrictEqual(bridge.metadata.page, {});
        });
    });

    describe("remove()", () => {
        test("supprime le fichier, la mémoire et l'entrée du registre", async () => {
            await bridge.register(page());
            const file = html_file("page", 1);
            await bridge.remove({post_type: "page", id: 1});

            assert.strictEqual(await exists(file), false);
            assert.deepStrictEqual(bridge.metadata.page, {});
            assert.deepStrictEqual(bridge.data.page, {});
            assert.deepStrictEqual((await read_registry()).page, {});
        });

        test("supprime un brouillon", async () => {
            await bridge.register(post({status: "draft"}));
            await bridge.remove({post_type: "post", id: 2});

            assert.deepStrictEqual(bridge.metadata.post, {});
        });

        test("ignore un contenu non enregistré", async () => {
            await bridge.remove({post_type: "page", id: 99});
        });
    });

    describe("get_by_id()", () => {
        test("retourne les métadonnées et le contenu (chaîne UTF-8)", async () => {
            await bridge.register(post());
            const res = await bridge.get_by_id("post", 2);

            assert.strictEqual(res.title, "Premier article");
            assert.strictEqual(res.content, "<html>1:premier-article</html>");
        });

        test("accepte un id numérique ou textuel", async () => {
            await bridge.register(page());
            assert.strictEqual((await bridge.get_by_id("page", 1)).slug, "a-propos");
            assert.strictEqual((await bridge.get_by_id("page", "1")).slug, "a-propos");
        });

        test("ignore les clés héritées", async () => {
            await assert.rejects(bridge.get_by_id("page", "toString"), /POST_NOT_FOUND/);
        });

        test("refuse un contenu non publié", async () => {
            await bridge.register(page({status: "draft"}));
            await assert.rejects(bridge.get_by_id("page", 1), /UNPUBLISHED_POST/);
        });

        test("relit le disque si le contenu manque en mémoire", async () => {
            await bridge.register(page());
            delete bridge.data.page[1];

            assert.strictEqual((await bridge.get_by_id("page", 1)).content, "<html>1:a-propos</html>");
            assert.strictEqual(bridge.data.page[1], "<html>1:a-propos</html>");
        });

        for(const [label, make] of [["en mémoire", page], ["hors mémoire", post]]) {
            test(`lève CACHED_READ_ERROR si le fichier manque (${label})`, async () => {
                const item = make();
                wp.missing.add(item.slug);
                await bridge.register(item);

                await assert.rejects(bridge.get_by_id(item.post_type, item.id), /CACHED_READ_ERROR/);
            });
        }

        test("refuse un type non géré", async () => {
            await assert.rejects(bridge.get_by_id("product", 1), /UNSUPPORTED_POST_TYPE/);
        });
    });

    describe("get_by_slug()", () => {
        test("retourne le contenu publié", async () => {
            await bridge.register(page());
            assert.strictEqual((await bridge.get_by_slug("page", "a-propos")).content, "<html>1:a-propos</html>");
        });

        test("ignore un brouillon qui partage le slug", async () => {
            await bridge.register(page({id: 1, slug: "", status: "draft"}));
            await bridge.register(page({id: 2, slug: ""}));

            const res = await bridge.get_by_slug("page", "");
            assert.strictEqual(res.uuid, bridge.metadata.page[2].uuid);
        });

        test("traite un slug uniquement en brouillon comme introuvable", async () => {
            await bridge.register(page({status: "draft"}));
            await assert.rejects(bridge.get_by_slug("page", "a-propos"), /POST_NOT_FOUND/);
        });

        test("refuse un type non géré", async () => {
            await assert.rejects(bridge.get_by_slug("product", "x"), /UNSUPPORTED_POST_TYPE/);
        });
    });

    describe("update_cache()", () => {
        test("retélécharge les contenus publiés et met à jour la mémoire", async () => {
            await bridge.register(page());
            await bridge.register(post());
            wp.version = 2;
            await bridge.update_cache();

            assert.strictEqual(bridge.data.page[1], "<html>2:a-propos</html>");
            assert.strictEqual(await fs_p.readFile(html_file("post", 2), "utf8"), "<html>2:premier-article</html>");
        });

        test("ignore les brouillons", async () => {
            await bridge.register(page({status: "draft"}));
            await bridge.update_cache();
            assert.deepStrictEqual(wp.hits, []);
        });

        test("continue après un échec", async () => {
            await bridge.register(page());
            await bridge.register(page({id: 3, slug: "contact"}));
            wp.version = 2;
            wp.missing.add("a-propos");
            await bridge.update_cache();

            assert.strictEqual(bridge.data.page[1], "<html>1:a-propos</html>");
            assert.strictEqual(bridge.data.page[3], "<html>2:contact</html>");
        });
    });

    describe("destroy()", () => {
        test("sauvegarde le registre et libère le bridge", async () => {
            await bridge.register(page());
            await bridge.destroy();

            assert.strictEqual(bridge.initialized, false);
            assert.deepStrictEqual(bridge.data, {});
            assert.deepStrictEqual(Object.keys((await read_registry()).page), ["1"]);
        });

        test("refuse toute opération après destruction", async () => {
            await bridge.destroy();
            await assert.rejects(bridge.register(page()), /NOT_INITIALIZED/);
        });

        test("peut être appelé plusieurs fois ou avant init()", async () => {
            await bridge.destroy();
            await bridge.destroy();
            await new_bridge(await make_dir(), wp.url).destroy();
        });

        test("attend la fin des opérations en cours", async () => {
            await bridge.register(post());
            wp.delay = 100;
            const registering = bridge.register(page());
            const updating = bridge.update({post_type: "post", id: 2, title: "Modifié"});
            await new Promise(resolve => setTimeout(resolve, 20));

            await bridge.destroy();
            await Promise.all([registering, updating]);

            const registry = await read_registry();
            assert.strictEqual(registry.post[2].title, "Modifié");
            assert.ok(await exists(path.join(dir, "contents", "page", `${registry.page[1].uuid}.html`)));
        });

        test("refuse les nouvelles opérations pendant la destruction", async () => {
            wp.delay = 50;
            const registering = bridge.register(page());
            const destroying = bridge.destroy();

            await assert.rejects(bridge.register(post()), /DESTROYING/);
            await assert.rejects(bridge.remove({post_type: "page", id: 1}), /DESTROYING/);
            await assert.rejects(bridge.update_cache(), /DESTROYING/);
            await Promise.all([registering, destroying]);

            await assert.rejects(bridge.register(post()), /NOT_INITIALIZED/);
        });

        test("un second appel attend la fin de la première destruction", async () => {
            wp.delay = 50;
            bridge.register(page());

            const first = bridge.destroy();
            await bridge.destroy();
            assert.strictEqual(bridge.metadata_file.handle, null);
            assert.strictEqual(bridge.pending.size, 0);
            await first;
        });

        test("ferme metadata.json même si la sauvegarde échoue", async () => {
            const file = bridge.metadata_file;
            file.save = () => Promise.reject(new Error("DISK_FULL"));

            await assert.rejects(bridge.destroy(), /DISK_FULL/);
            assert.strictEqual(file.handle, null);
            assert.strictEqual(bridge.initialized, false);
        });

        test("le bridge peut être réinitialisé", async () => {
            await bridge.register(page());
            await bridge.destroy();
            await bridge.init();

            assert.strictEqual((await bridge.get_by_id("page", 1)).content, "<html>1:a-propos</html>");
        });
    });

    describe("événements", () => {
        const record = (...events) => {
            const calls = [];
            for(const event of events) bridge.on(event, arg => calls.push([event, arg]));
            return calls;
        };

        test("on() et off() refusent un événement inconnu", () => {
            assert.throws(() => bridge.on("deleted", () => {}), /UNKNOWN_EVENT/);
            assert.throws(() => bridge.off("deleted", () => {}), /UNKNOWN_EVENT/);
        });

        test("initialized et destroyed reçoivent le bridge", async () => {
            const calls = record("initialized", "destroyed");
            await bridge.destroy();
            await bridge.init();

            assert.deepStrictEqual(calls, [["destroyed", bridge], ["initialized", bridge]]);
        });

        test("destroyed est déclenché une fois la destruction terminée, même en échec", async () => {
            let state;
            bridge.on("destroyed", () => state = {initialized: bridge.initialized, destroying: bridge.destroying});
            bridge.metadata_file.save = () => Promise.reject(new Error("DISK_FULL"));

            await assert.rejects(bridge.destroy(), /DISK_FULL/);
            assert.deepStrictEqual(state, {initialized: false, destroying: null});
        });

        test("registered, updated et removed reçoivent le contenu après traitement", async () => {
            const calls = [];
            for(const event of ["registered", "updated", "removed"])
                bridge.on(event, ({post_type, id, post}) => calls.push([event, post_type, id, post.title, bridge.data.page[1]]));

            await bridge.register(page());
            wp.version = 2;
            await bridge.update({post_type: "page", id: "1", title: "Modifié"});
            await bridge.remove({post_type: "page", id: "1"});

            assert.deepStrictEqual(calls, [
                ["registered", "page", "1", "À propos", "<html>1:a-propos</html>"],
                ["updated", "page", "1", "Modifié", "<html>2:a-propos</html>"],
                ["removed", "page", "1", "Modifié", undefined]
            ]);
        });

        test("registered est déclenché même si le téléchargement échoue", async () => {
            const calls = record("registered");
            wp.missing.add("a-propos");
            await bridge.register(page());

            assert.strictEqual(calls.length, 1);
        });

        test("rien n'est déclenché pour un appel refusé ou ignoré", async () => {
            const calls = record("registered", "updated", "removed");
            await bridge.register(page());
            calls.length = 0;

            await assert.rejects(bridge.register(page()), /ALREADY_REGISTERED_POST/);
            await assert.rejects(bridge.register(page({post_type: "product"})), /UNSUPPORTED_POST_TYPE/);
            await bridge.update(page({id: "99"}));
            await bridge.remove({post_type: "page", id: "99"});

            assert.deepStrictEqual(calls, []);
        });

        test("cache_updated est déclenché à la fin de update_cache()", async () => {
            await bridge.register(page());
            let content;
            bridge.on("cache_updated", b => content = b.data.page[1]);
            wp.version = 2;
            await bridge.update_cache();

            assert.strictEqual(content, "<html>2:a-propos</html>");
        });

        test("off() retire l'écouteur", async () => {
            const calls = [];
            const listener = () => calls.push(1);
            bridge.on("registered", listener);
            bridge.off("registered", listener);
            bridge.off("registered", listener);
            await bridge.register(page());

            assert.deepStrictEqual(calls, []);
        });

        test("un écouteur qui se retire ne fait pas sauter le suivant", async () => {
            const calls = [];
            const once = () => {
                calls.push("once");
                bridge.off("registered", once);
            };
            bridge.on("registered", once);
            bridge.on("registered", () => calls.push("next"));

            await bridge.register(page());
            await bridge.register(post());
            assert.deepStrictEqual(calls, ["once", "next", "next"]);
        });

        test("les erreurs des écouteurs sont journalisées sans faire échouer l'opération", async () => {
            const utils = require("../src/utils");
            const log = utils.log;
            const logged = [];
            utils.log = data => logged.push(data);

            try {
                const calls = [];
                bridge.on("registered", () => {
                    calls.push("sync");
                    throw new Error("SYNC");
                });
                bridge.on("registered", async () => {
                    calls.push("async");
                    throw new Error("ASYNC");
                });
                bridge.on("registered", () => calls.push("last"));

                await bridge.register(page());
                await new Promise(resolve => setImmediate(resolve));

                assert.deepStrictEqual(calls, ["sync", "async", "last"]);
                assert.ok(bridge.metadata.page[1]);
                const errors = logged.filter(_ => _.message === "EVENT LISTENER ERROR");
                assert.deepStrictEqual(errors.map(_ => [_.res.event, _.reason.message]), [["registered", "SYNC"], ["registered", "ASYNC"]]);
            } finally {
                utils.log = log;
            }
        });
    });

    test("respecte les options post_types et types_to_buffer", async () => {
        await bridge.destroy();
        bridge = await init_bridge(await make_dir(), wp.url, {post_types: ["post"], types_to_buffer: ["post"]});

        await assert.rejects(bridge.register(page()), /UNSUPPORTED_POST_TYPE/);
        await bridge.register(post());
        assert.strictEqual(bridge.data.post[2], "<html>1:premier-article</html>");
    });
});
