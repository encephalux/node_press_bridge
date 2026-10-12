const {describe, test} = require("node:test");
const assert = require("node:assert");
const middleware = require("../src/middleware");
const controllers = require("../src/controllers");
const {page, post} = require("./helpers");

const fake_bridge = (overrides = {}) => ({
    options: {post_types: ["page", "post"]},
    calls: [],
    ...overrides
});

/** Runs a middleware and reports whether it called next() or ended the request. */
function run(mw, body, req = {}) {
    req.body = body;
    let ended = false, next_called = false;
    mw(req, {end: () => ended = true}, () => next_called = true);
    return {req, ended, next_called};
}

describe("middleware", () => {
    const mw = middleware(fake_bridge());

    for(const name of ["add", "update"]) {
        describe(name, () => {
            test("crée req.data_waggon pour une page valide", () => {
                const {req, next_called} = run(mw[name], page());

                assert.ok(next_called);
                const {excerpt, ...expected} = page();
                assert.deepStrictEqual(req.data_waggon, {...expected, id: "1"});
            });

            test("transmet l'extrait d'un article", () => {
                const {req} = run(mw[name], post({excerpt: ""}));
                assert.strictEqual(req.data_waggon.excerpt, "");
            });

            test("complète un req.data_waggon existant", () => {
                const {req} = run(mw[name], page(), {data_waggon: {extra: 1}});
                assert.strictEqual(req.data_waggon.extra, 1);
                assert.strictEqual(req.data_waggon.id, "1");
            });

            test("accepte un slug et une miniature vides", () => {
                assert.ok(run(mw[name], page({slug: "", thumbnail: ""})).next_called);
            });

            test("accepte un id numérique ou textuel et le normalise en chaîne", () => {
                for(const id of [42, "42"]) {
                    const {req, next_called} = run(mw[name], page({id}));
                    assert.ok(next_called);
                    assert.strictEqual(req.data_waggon.id, "42");
                }
            });

            const invalid = {
                "id manquant": page({id: undefined}),
                "id nul": page({id: 0}),
                "id négatif": page({id: -1}),
                "id décimal": page({id: 1.5}),
                "id non numérique": page({id: "__proto__"}),
                "id hexadécimal": page({id: "0x1A"}),
                "id entouré d'espaces": page({id: " 7 "}),
                "id avec zéro initial": page({id: "07"}),
                "id booléen": page({id: true}),
                "type non géré": page({post_type: "product"}),
                "titre vide": page({title: ""}),
                "slug absent": page({slug: undefined}),
                "miniature absente": page({thumbnail: undefined}),
                "extrait absent pour un article": post({excerpt: undefined}),
                "statut absent": page({status: undefined})
            };

            for(const [label, body] of Object.entries(invalid)) {
                test(`termine la requête si ${label}`, () => {
                    const {ended, next_called} = run(mw[name], body);
                    assert.ok(ended);
                    assert.ok(!next_called);
                });
            }
        });
    }

    describe("remove", () => {
        test("ne garde que post_type et id", () => {
            const {req, next_called} = run(mw.remove, page());

            assert.ok(next_called);
            assert.deepStrictEqual(req.data_waggon, {post_type: "page", id: 1});
        });

        test("termine la requête si l'id manque", () => {
            const {ended, next_called} = run(mw.remove, {post_type: "page"});
            assert.ok(ended);
            assert.ok(!next_called);
        });
    });
});

describe("controllers", () => {
    const actions = {add: "register", update: "update", remove: "remove"};

    for(const [name, method] of Object.entries(actions)) {
        test(`${name} répond puis appelle bridge.${method}()`, async () => {
            const order = [];
            const data_waggon = {post_type: "page", id: 1};
            const bridge = fake_bridge({
                [method]: async arg => {
                    order.push(["bridge", arg]);
                    throw new Error("ignorée");
                }
            });

            controllers(bridge)[name]({data_waggon}, {end: () => order.push(["end"])});
            await new Promise(setImmediate);

            assert.deepStrictEqual(order, [["end"], ["bridge", data_waggon]]);
        });
    }
});
